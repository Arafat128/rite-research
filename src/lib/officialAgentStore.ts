/**
 * Browser registry for Official Ritual agents launched from Rite.
 * Separate from Radar data-agent storage.
 */

export type OfficialAgentRecord = {
  kind: "sovereign" | "persistent";
  name: string;
  owner: string;
  /** Child harness (sovereign) or launcher (persistent) */
  childAddress: string;
  userSalt: string;
  createTx?: string;
  createdAt: number;
  prompt?: string;
  model?: string;
  executor?: string;
  /** User notes / status */
  status?: string;
};

const KEY = "rite_official_agents_v1";

function readAll(): OfficialAgentRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    return JSON.parse(raw) as OfficialAgentRecord[];
  } catch {
    return [];
  }
}

function writeAll(rows: OfficialAgentRecord[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(rows.slice(0, 80)));
  } catch {
    /* quota */
  }
}

export function listOfficialAgents(owner?: string): OfficialAgentRecord[] {
  const all = readAll();
  if (!owner) return all;
  return all.filter(
    (a) => a.owner.toLowerCase() === owner.toLowerCase()
  );
}

export function registerOfficialAgent(rec: OfficialAgentRecord) {
  const all = readAll().filter(
    (a) =>
      a.childAddress.toLowerCase() !== rec.childAddress.toLowerCase() ||
      a.owner.toLowerCase() !== rec.owner.toLowerCase()
  );
  all.unshift(rec);
  writeAll(all);
}

export function removeOfficialAgent(childAddress: string, owner: string) {
  writeAll(
    readAll().filter(
      (a) =>
        !(
          a.childAddress.toLowerCase() === childAddress.toLowerCase() &&
          a.owner.toLowerCase() === owner.toLowerCase()
        )
    )
  );
}
