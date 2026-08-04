"use client";
import { useState } from "react";
import { Plus, AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { requestJson } from "@/lib/client-api";

export function AddProviderSheet({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<"oidc" | "saml">("oidc");

  // OIDC form state
  const [oidcProviderId, setOidcProviderId] = useState("");
  const [oidcIssuer, setOidcIssuer] = useState("");
  const [oidcDomain, setOidcDomain] = useState("");
  const [oidcClientId, setOidcClientId] = useState("");
  const [oidcClientSecret, setOidcClientSecret] = useState("");

  // SAML form state
  const [samlProviderId, setSamlProviderId] = useState("");
  const [samlIssuer, setSamlIssuer] = useState("");
  const [samlDomain, setSamlDomain] = useState("");
  const [samlEntryPoint, setSamlEntryPoint] = useState("");
  const [samlCert, setSamlCert] = useState("");
  const [samlEntityId, setSamlEntityId] = useState("warehousd-sp");
  const [samlAuthnSigned, setSamlAuthnSigned] = useState(false);
  const [samlAssertionSigned, setSamlAssertionSigned] = useState(true);

  async function submitOidc() {
    if (
      !oidcProviderId.trim() ||
      !oidcIssuer.trim() ||
      !oidcDomain.trim() ||
      !oidcClientId.trim() ||
      !oidcClientSecret.trim()
    ) {
      toast.error("All fields are required");
      return;
    }

    setSubmitting(true);
    try {
      const res = await requestJson("/api/sso/providers", {
        method: "POST",
        body: JSON.stringify({
          providerId: oidcProviderId,
          issuer: oidcIssuer,
          domain: oidcDomain,
          oidcConfig: {
            clientId: oidcClientId,
            clientSecret: oidcClientSecret,
            discoveryEndpoint: `${oidcIssuer}/.well-known/openid-configuration`,
          },
        }),
      });

      if (!res.ok) {
        toast.error(`Error: ${res.error}`);
        return;
      }

      toast.success("Provider added successfully");
      setOpen(false);
      resetOidcForm();
      onAdded();
    } finally {
      setSubmitting(false);
    }
  }

  async function submitSaml() {
    if (
      !samlProviderId.trim() ||
      !samlIssuer.trim() ||
      !samlDomain.trim() ||
      !samlEntryPoint.trim() ||
      !samlCert.trim()
    ) {
      toast.error("All fields are required");
      return;
    }

    setSubmitting(true);
    try {
      const res = await requestJson("/api/sso/providers", {
        method: "POST",
        body: JSON.stringify({
          providerId: samlProviderId,
          issuer: samlIssuer,
          domain: samlDomain,
          samlConfig: {
            entryPoint: samlEntryPoint,
            cert: samlCert,
            callbackUrl: `${typeof window !== "undefined" ? window.location.origin : ""}/api/auth/sso/saml2/sp/acs/${samlProviderId}`,
            spMetadata: { entityID: samlEntityId },
            authnRequestsSigned: samlAuthnSigned,
            wantAssertionsSigned: samlAssertionSigned,
            mapping: {
              id: "email",
              email: "email",
              name: "given name",
              lastName: "family name",
            },
          },
        }),
      });

      if (!res.ok) {
        toast.error(`Error: ${res.error}`);
        return;
      }

      toast.success("SAML provider added successfully");
      setOpen(false);
      resetSamlForm();
      onAdded();
    } finally {
      setSubmitting(false);
    }
  }

  function resetOidcForm() {
    setOidcProviderId("");
    setOidcIssuer("");
    setOidcDomain("");
    setOidcClientId("");
    setOidcClientSecret("");
  }

  function resetSamlForm() {
    setSamlProviderId("");
    setSamlIssuer("");
    setSamlDomain("");
    setSamlEntryPoint("");
    setSamlCert("");
    setSamlEntityId("warehousd-sp");
    setSamlAuthnSigned(false);
    setSamlAssertionSigned(true);
  }

  function handleOpenChange(v: boolean) {
    setOpen(v);
    if (!v) {
      resetOidcForm();
      resetSamlForm();
      setActiveTab("oidc");
    }
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        <Button>
          <Plus size={16} className="mr-2" />
          Add provider
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Add identity provider</SheetTitle>
          <SheetDescription>
            Configure a new SSO provider. Users will be provisioned as members on first sign-in.
          </SheetDescription>
        </SheetHeader>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as "oidc" | "saml")}
          className="flex-1 flex flex-col"
        >
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="oidc">OIDC</TabsTrigger>
            <TabsTrigger value="saml">SAML</TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-y-auto px-4">
            <TabsContent value="oidc" className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label htmlFor="oidc-provider-id">
                  Provider ID <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="oidc-provider-id"
                  placeholder="acme-oidc"
                  value={oidcProviderId}
                  onChange={(e) =>
                    setOidcProviderId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  An internal id. Appears in the sign-in button and cannot be changed later.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="oidc-issuer">
                  Issuer URL <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="oidc-issuer"
                  placeholder="https://oidc.example.com"
                  value={oidcIssuer}
                  onChange={(e) => setOidcIssuer(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Your IdP's issuer URL. Discovery runs against{" "}
                  {`{issuer}/.well-known/openid-configuration`}.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="oidc-domain">
                  Email domain <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="oidc-domain"
                  placeholder="example.com"
                  value={oidcDomain}
                  onChange={(e) => setOidcDomain(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Email domain routed to this provider.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="oidc-client-id">
                  Client ID <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="oidc-client-id"
                  placeholder="warehousd"
                  value={oidcClientId}
                  onChange={(e) => setOidcClientId(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="oidc-client-secret">
                  Client secret <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="oidc-client-secret"
                  type="password"
                  placeholder="••••••••"
                  value={oidcClientSecret}
                  onChange={(e) => setOidcClientSecret(e.target.value)}
                />
              </div>
            </TabsContent>

            <TabsContent value="saml" className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label htmlFor="saml-provider-id">
                  Provider ID <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="saml-provider-id"
                  placeholder="acme-saml"
                  value={samlProviderId}
                  onChange={(e) =>
                    setSamlProviderId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  An internal id. Appears in the sign-in button and cannot be changed later.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="saml-issuer">
                  Issuer URL <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="saml-issuer"
                  placeholder="https://saml.example.com"
                  value={samlIssuer}
                  onChange={(e) => setSamlIssuer(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="saml-domain">
                  Email domain <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="saml-domain"
                  placeholder="example.com"
                  value={samlDomain}
                  onChange={(e) => setSamlDomain(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Email domain routed to this provider.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="saml-entry-point">
                  Entry Point <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="saml-entry-point"
                  placeholder="https://saml.example.com/sso"
                  value={samlEntryPoint}
                  onChange={(e) => setSamlEntryPoint(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="saml-cert">
                  X.509 Certificate <span className="text-destructive">*</span>
                </Label>
                <textarea
                  id="saml-cert"
                  className="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 font-mono text-xs"
                  placeholder="-----BEGIN CERTIFICATE-----..."
                  value={samlCert}
                  onChange={(e) => setSamlCert(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="saml-entity-id">SP Entity ID</Label>
                <Input
                  id="saml-entity-id"
                  value={samlEntityId}
                  onChange={(e) => setSamlEntityId(e.target.value)}
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="saml-authn-signed"
                    checked={samlAuthnSigned}
                    onChange={(e) => setSamlAuthnSigned(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  <Label htmlFor="saml-authn-signed" className="font-normal cursor-pointer">
                    Sign authentication requests
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="saml-assertion-signed"
                    checked={samlAssertionSigned}
                    onChange={(e) => setSamlAssertionSigned(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  <Label htmlFor="saml-assertion-signed" className="font-normal cursor-pointer">
                    Require signed assertions
                  </Label>
                </div>
              </div>
            </TabsContent>
          </div>

          <div className="border-t px-4 py-3 space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-pending/40 p-3 text-xs text-muted-foreground">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-pending" />
              <p>
                Private and loopback issuers are rejected by discovery unless the host is listed in{" "}
                <span className="font-mono">WAREHOUSD_TRUSTED_ORIGINS</span>.
              </p>
            </div>

            <SheetFooter className="gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={activeTab === "oidc" ? submitOidc : submitSaml}
                disabled={submitting}
              >
                {submitting && <Loader2 size={16} className="mr-2 animate-spin" />}
                Add provider
              </Button>
            </SheetFooter>
          </div>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
