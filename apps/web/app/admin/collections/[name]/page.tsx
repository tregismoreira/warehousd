import { CollectionDetail } from "./CollectionDetail";

export default async function CollectionPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <CollectionDetail name={name} />;
}
