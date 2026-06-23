import { registeredExtractors } from "@beacon/core";
import { getStore } from "../../lib/store";
import { AddSiteWizard } from "../../components/AddSiteWizard";

export const dynamic = "force-dynamic";

export default async function AddSitePage() {
  const store = await getStore();
  const schedules = await store.schedules.all();

  const scheduleOptions = [
    { value: "5", label: "5 min" },
    { value: "15", label: "15 min" },
    { value: "20", label: "20 min" },
    { value: "30", label: "30 min" },
    { value: "60", label: "60 min" },
    ...Object.entries(schedules).map(([k, d]) => ({ value: k, label: d.label ?? k })),
  ];

  return (
    <>
      <div className="sect-hd">
        <h2>Add a site</h2>
        <span className="rule" />
      </div>
      <p className="muted" style={{ marginTop: -4, marginBottom: 14 }}>
        Probe a URL to auto-detect the recipe, tweak the config, preview what it parses, then save — no code, no redeploy.
      </p>
      <AddSiteWizard scheduleOptions={scheduleOptions} extractors={registeredExtractors()} />
    </>
  );
}
