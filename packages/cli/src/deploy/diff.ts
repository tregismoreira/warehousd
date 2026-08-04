import {
  normalizePosture,
  planFromConfigs,
  type WarehousdConfig,
  type CollectionConfig,
  type DeployConfig,
} from "@warehousd/broker";

interface DiffItem {
  priority: number;
  text: string;
}

export function renderConfigDiff(prev: WarehousdConfig | null, next: WarehousdConfig): string {
  if (prev === null) {
    return "no previous deploy state on this machine — deploying full config";
  }

  const items: DiffItem[] = [];

  compareSchema(prev, next, items);
  compareDeploy(prev.deploy, next.deploy, items);
  compareCollections(prev.collections, next.collections, items);
  compareTaxonomies(prev.collections, next.collections, items);

  if (items.length === 0) {
    return "no changes";
  }

  items.sort((a, b) => b.priority - a.priority);
  return items.map((item) => item.text).join("\n");
}

// Above the posture changes at 100, because this is the only category that can end the deploy: a
// posture change is a policy decision the operator meant to make, while an unmigrated type change
// is refused outright by the release command and takes the deploy with it.
const SCHEMA_PRIORITY = 110;

function compareSchema(prev: WarehousdConfig, next: WarehousdConfig, items: DiffItem[]): void {
  const blocking = planFromConfigs(prev, next).filter((c) => c.destructive);
  if (blocking.length === 0) return;

  const lines = blocking.map(
    (c) => `  ! ${c.detail}${c.reviewRequired ? "" : " (lossless, but still needs a migration)"}`,
  );
  items.push({
    priority: SCHEMA_PRIORITY,
    text:
      `REQUIRES MIGRATION — these changes would destroy or strand live data:\n${lines.join("\n")}\n` +
      `  Run \`warehousd migrate generate\` before deploying; the release command refuses ` +
      `without it.`,
  });
}

function compareDeploy(
  prev: DeployConfig | undefined,
  next: DeployConfig | undefined,
  items: DiffItem[],
): void {
  const prevDeployLines: string[] = [];
  const nextDeployLines: string[] = [];

  if (prev === undefined && next === undefined) {
    return;
  }

  if (prev?.app_name !== next?.app_name) {
    prevDeployLines.push(`app_name: ${prev?.app_name ?? "(unset)"}`);
    nextDeployLines.push(`app_name: ${next?.app_name ?? "(unset)"}`);
  }

  if (prev?.region !== next?.region) {
    prevDeployLines.push(`region: ${prev?.region ?? "(unset)"}`);
    nextDeployLines.push(`region: ${next?.region ?? "(unset)"}`);
  }

  if (prev?.image !== next?.image) {
    prevDeployLines.push(`image: ${prev?.image ?? "(unset)"}`);
    nextDeployLines.push(`image: ${next?.image ?? "(unset)"}`);
  }

  const prevDbMgd = prev?.database.managed;
  const prevDbUrl = prev?.database.url;
  const nextDbMgd = next?.database.managed;
  const nextDbUrl = next?.database.url;

  if (prevDbMgd !== nextDbMgd || prevDbUrl !== nextDbUrl) {
    const prevDbStr =
      prevDbMgd === true ? "managed: true" : prevDbUrl ? `url: ${prevDbUrl}` : "(unset)";
    const nextDbStr =
      nextDbMgd === true ? "managed: true" : nextDbUrl ? `url: ${nextDbUrl}` : "(unset)";
    prevDeployLines.push(`database: ${prevDbStr}`);
    nextDeployLines.push(`database: ${nextDbStr}`);
  }

  if (prevDeployLines.length > 0) {
    items.push({
      priority: 50,
      text: `Deploy:\n  ${prevDeployLines.map((l) => `- ${l}`).join("\n  ")}\n  ${nextDeployLines.map((l) => `+ ${l}`).join("\n  ")}`,
    });
  }
}

function compareCollections(
  prevCollections: Record<string, CollectionConfig>,
  nextCollections: Record<string, CollectionConfig>,
  items: DiffItem[],
): void {
  const prevKeys = Object.keys(prevCollections);
  const nextKeys = Object.keys(nextCollections);
  const prevSet = new Set(prevKeys);
  const nextSet = new Set(nextKeys);

  const addedCollections: string[] = [];
  const removedCollections: string[] = [];

  for (const key of nextKeys) {
    if (!prevSet.has(key)) {
      addedCollections.push(key);
    }
  }

  for (const key of prevKeys) {
    if (!nextSet.has(key)) {
      removedCollections.push(key);
    }
  }

  const collectionChanges: string[] = [];

  if (removedCollections.length > 0) {
    collectionChanges.push(...removedCollections.map((name) => `- removed: ${name}`));
  }

  if (addedCollections.length > 0) {
    collectionChanges.push(...addedCollections.map((name) => `+ added: ${name}`));
  }

  if (collectionChanges.length > 0) {
    items.push({
      priority: 40,
      text: `Collections:\n  ${collectionChanges.join("\n  ")}`,
    });
  }

  for (const collName of nextKeys) {
    if (prevSet.has(collName)) {
      compareFields(collName, prevCollections[collName]!, nextCollections[collName]!, items);
      compareWritable(collName, prevCollections[collName]!, nextCollections[collName]!, items);
    }
  }
}

function compareFields(
  collName: string,
  prevColl: CollectionConfig,
  nextColl: CollectionConfig,
  items: DiffItem[],
): void {
  const prevFields = prevColl.fields;
  const nextFields = nextColl.fields;
  const prevFieldNames = Object.keys(prevFields);
  const nextFieldNames = Object.keys(nextFields);

  const prevSet = new Set(prevFieldNames);
  const nextSet = new Set(nextFieldNames);

  const postureChanges: { text: string; priority: number }[] = [];
  const fieldAdditions: string[] = [];
  const fieldRemovals: string[] = [];

  for (const fieldName of nextFieldNames) {
    if (prevSet.has(fieldName)) {
      const prevPosture = normalizePosture(prevFields[fieldName]!.posture);
      const nextPosture = normalizePosture(nextFields[fieldName]!.posture);

      if (prevPosture.read !== nextPosture.read) {
        postureChanges.push({
          text: `* ${collName}.${fieldName}: read ${prevPosture.read} → ${nextPosture.read} (HIGH CONSEQUENCE)`,
          priority: 100,
        });
      }

      if (prevPosture.write !== nextPosture.write) {
        postureChanges.push({
          text: `* ${collName}.${fieldName}: write ${prevPosture.write} → ${nextPosture.write} (HIGH CONSEQUENCE)`,
          priority: 100,
        });
      }
    } else {
      fieldAdditions.push(`+ ${fieldName}`);
    }
  }

  for (const fieldName of prevFieldNames) {
    if (!nextSet.has(fieldName)) {
      fieldRemovals.push(`- ${fieldName}`);
    }
  }

  const fieldChanges: string[] = [...fieldRemovals, ...fieldAdditions];

  if (postureChanges.length > 0) {
    for (const change of postureChanges) {
      items.push({
        priority: change.priority,
        text: change.text,
      });
    }
  }

  if (fieldChanges.length > 0) {
    items.push({
      priority: 30,
      text: `Fields in '${collName}':\n  ${fieldChanges.join("\n  ")}`,
    });
  }
}

function compareWritable(
  collName: string,
  prevColl: CollectionConfig,
  nextColl: CollectionConfig,
  items: DiffItem[],
): void {
  const prevWritable = prevColl.writable ?? false;
  const nextWritable = nextColl.writable ?? false;

  if (prevWritable !== nextWritable) {
    const action = nextWritable ? "added" : "removed";
    items.push({
      priority: 35,
      text: `Collection '${collName}': writable ${action}`,
    });
  }
}

function compareTaxonomies(
  prevCollections: Record<string, CollectionConfig>,
  nextCollections: Record<string, CollectionConfig>,
  items: DiffItem[],
): void {
  const taxonomyChanges: string[] = [];

  for (const collName of Object.keys(nextCollections)) {
    if (!Object.hasOwn(prevCollections, collName)) {
      continue;
    }

    const prevTaxonomies = prevCollections[collName]!.taxonomies ?? [];
    const nextTaxonomies = nextCollections[collName]!.taxonomies ?? [];

    const prevSet = new Set(prevTaxonomies);
    const nextSet = new Set(nextTaxonomies);

    for (const tax of nextTaxonomies) {
      if (!prevSet.has(tax)) {
        taxonomyChanges.push(`+ '${tax}': added to '${collName}'`);
      }
    }

    for (const tax of prevTaxonomies) {
      if (!nextSet.has(tax)) {
        taxonomyChanges.push(`- '${tax}': removed from '${collName}'`);
      }
    }
  }

  if (taxonomyChanges.length > 0) {
    items.push({
      priority: 20,
      text: `Taxonomies:\n  ${taxonomyChanges.join("\n  ")}`,
    });
  }
}
