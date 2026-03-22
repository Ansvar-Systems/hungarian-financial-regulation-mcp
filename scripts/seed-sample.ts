/**
 * Seed the MNB database with sample provisions for testing.
 *
 * Inserts representative provisions from MNB_Rendeletek, MNB_Ajanlasok,
 * and MNB_Vezetoi_Korlevelek sourcebooks so MCP tools can be tested
 * without running a full ingest.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["MNB_DB_PATH"] ?? "data/mnb.db";
const force = process.argv.includes("--force");

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

// --- Sourcebooks ---

interface SourcebookRow {
  id: string;
  name: string;
  description: string;
}

const sourcebooks: SourcebookRow[] = [
  {
    id: "MNB_RENDELETEK",
    name: "MNB Rendeletek",
    description:
      "Magyar Nemzeti Bank rendeletek — prudencialis kovetelmenyek, tokemegfeleles, es felugyeleti elvarasok.",
  },
  {
    id: "MNB_AJANLASOK",
    name: "MNB Ajanlasok",
    description:
      "Magyar Nemzeti Bank ajanlasok — IT kockazat, belso iranyitas, ugyfelvedelem, es mukodesi kockazat.",
  },
  {
    id: "MNB_VEZETOI_KORLEVELEK",
    name: "MNB Vezeto Korlevelek",
    description:
      "Magyar Nemzeti Bank vezeto korlevelek — felugyeleti elvek, technikai iranymutatak, es jogertelmezesek.",
  },
];

const insertSourcebook = db.prepare(
  "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
);

for (const sb of sourcebooks) {
  insertSourcebook.run(sb.id, sb.name, sb.description);
}

console.log(`Inserted ${sourcebooks.length} sourcebooks`);

// --- Sample provisions ---

interface ProvisionRow {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string;
  chapter: string;
  section: string;
}

const provisions: ProvisionRow[] = [
  // MNB Rendeletek — prudential requirements
  {
    sourcebook_id: "MNB_RENDELETEK",
    reference: "MNB rendelet 2/2015",
    title: "A hitelintezetek tokemegfelelesere vonatkozo rendelet",
    text: "A hitelintezetek kotelessek megfelelo tokeszintet fenntartani a kockazataikkal aranyban. A tokemegfeleles szamitasat es jelentes kesziteset a rendelet III. fejezete szabalyozza, osszhangban az EU 575/2013 rendelettel (CRR).",
    type: "rendelet",
    status: "in_force",
    effective_date: "2015-03-01",
    chapter: "III",
    section: "3.1",
  },
  {
    sourcebook_id: "MNB_RENDELETEK",
    reference: "MNB rendelet 4/2015",
    title: "A penzintezetek likviditas-kovetelmenyeire vonatkozo rendelet",
    text: "A penzugyi intezmenyek kotelessek megfelelő likviditasi szintet fenntartani. A Likvidiasi Fedezeti Ration (LCR) minimum 100%-os szintjet kell teljesiteni minden idoben. A Netto Stabil Finanszirozasi Arany (NSFR) minimum elvarasait 2018-tol kell alkalmazni.",
    type: "rendelet",
    status: "in_force",
    effective_date: "2015-07-01",
    chapter: "II",
    section: "2.3",
  },
  {
    sourcebook_id: "MNB_RENDELETEK",
    reference: "MNB rendelet 9/2018",
    title: "A fizetesi szolgaltatokra vonatkozo prudencialis rendelet",
    text: "A fizetesi intezmenyek es elektronikuspenz-kibocstok szamara kotelező a minimalis tokekovetelmenyek betartasa. Az iras reszletezi a kockazati kategoriakat, a tokeszamitasi modszereket es az MNB-nek benyujtando rendszeres jelentes formajat.",
    type: "rendelet",
    status: "in_force",
    effective_date: "2018-11-01",
    chapter: "IV",
    section: "4.2",
  },
  {
    sourcebook_id: "MNB_RENDELETEK",
    reference: "MNB rendelet 12/2021",
    title: "A kriptovaluta-szolgaltatok engedelyezesere vonatkozo rendelet",
    text: "A kriptovaluta-eszkozt forgalmazo vagy tarolo vállalkozasok MNB engedelyhez kotottek. Az engedelykerelem tartalmazza a vallalat szervezeti felepteset, belso iranyitasi rendszeret, tokefederl bizonylatot es az ugyfelvedeimi politikat.",
    type: "rendelet",
    status: "in_force",
    effective_date: "2021-09-01",
    chapter: "I",
    section: "1.4",
  },

  // MNB Ajanlasok — recommendations
  {
    sourcebook_id: "MNB_AJANLASOK",
    reference: "MNB ajanlas 7/2021",
    title: "IT kockazatkezelesi ajanlas penzugyi intezmenyek szamara",
    text: "Az MNB elvarasa, hogy minden felugyelete ala tartozo penzugyi intezmenyek megfelelő IT kockazatkezelesi keretrendszert mukodtessenek. Az ajanlasban foglalt elvek kiterjed az IT rendszerek biztonsagara, az adatvedelemre, az uzemfolytositasra, valamint a kiberbiztonsagi elvarasokra.",
    type: "ajanlas",
    status: "in_force",
    effective_date: "2021-06-01",
    chapter: "II",
    section: "2.1",
  },
  {
    sourcebook_id: "MNB_AJANLASOK",
    reference: "MNB ajanlas 3/2022",
    title: "A penzugyi intezmenyek penzmosamelleni kovetelmenyek ajanlas",
    text: "Az MNB elvarasa, hogy a penzugyi intezmenyek hatekony penzmosamellenes (AML) es terrorizmus finanszirozasanak megelozesere iranyulo (CFT) rendszereket mukodtessenek. Ide tartozik az ugyfelet megismero eljarasok (KYC/CDD/EDD), a tranzakciofigyelesi rendszerek, es a gyanus tranzakciok bejelentese.",
    type: "ajanlas",
    status: "in_force",
    effective_date: "2022-03-01",
    chapter: "III",
    section: "3.2",
  },
  {
    sourcebook_id: "MNB_AJANLASOK",
    reference: "MNB ajanlas 11/2020",
    title: "A hitelezesi kockazatkezelesi ajanlas",
    text: "Az ajanlás az MNB elvarasait tartalmazza a hitelintezetek hitelezesi kockazatkezelesi gyakorlataira vonatkozoan. Foglalkozik a hitelminositesi eljarasokkal, az egyedi es portfólio szintu kockazatkereskedelemmel, az ertekvestes eljarasokkal, es a nemteljesitési esemenyekre vonatkozo kezelesi politikaval.",
    type: "ajanlas",
    status: "in_force",
    effective_date: "2020-09-01",
    chapter: "IV",
    section: "4.1",
  },

  // MNB Vezetoi Korlevelek — management circulars
  {
    sourcebook_id: "MNB_VEZETOI_KORLEVELEK",
    reference: "MNB VK 2/2023",
    title: "Kibertamadasi esemenyjelentesi kov — vezeto korlevel",
    text: "Az MNB elvarasa szerint a sulyos kibertamadasi esemenyeket 4 oran belul be kell jelenteni az MNB-nek. A korlevel reszletezi az esemenyjelentes eljarasat, az allamhatarokon ativelő esemenyekre vonatkozo EU koordinacios kovetelmenyt, es az utolagos reszletes elemzesi kotelezettsegeket.",
    type: "korlevel",
    status: "in_force",
    effective_date: "2023-01-15",
    chapter: "I",
    section: "1.2",
  },
  {
    sourcebook_id: "MNB_VEZETOI_KORLEVELEK",
    reference: "MNB VK 5/2022",
    title: "ESG kockazatok felugyeleti elvarse — vezeto korlevel",
    text: "Az MNB elvarasa szerint a penzugyi intezmenyek ESG (kornyezeti, tarsadalmi, iranyitasi) kockazatokat integraljan bele kockazatkezelesi folyamataikba. Felkeri az intezmenyek vezeto testuletet, hogy keszitsenek ESG kockazati elemzest, es ezt rendszeresen tekintse at.",
    type: "korlevel",
    status: "in_force",
    effective_date: "2022-07-01",
    chapter: "II",
    section: "2.4",
  },
  {
    sourcebook_id: "MNB_VEZETOI_KORLEVELEK",
    reference: "MNB VK 1/2024",
    title: "MI rendszerek alkalmazasanak felugyeleti elvarasai — vezeto korlevel",
    text: "Az MNB elvarasa szerint a penzugyi intezmenyek mesterseges intelligencia rendszerek alkalmazasa soran biztositsak az atlathatosagot, fair banasmódot, es a megalapozott kockazatkezelest. Tartalmazza az MI modellek validaciojahoz es a diszkriminacio elkerulesehez szuksges minimalis kovetelmenyek leirassat.",
    type: "korlevel",
    status: "in_force",
    effective_date: "2024-02-01",
    chapter: "I",
    section: "1.1",
  },
];

const insertProvision = db.prepare(`
  INSERT INTO provisions (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAll = db.transaction(() => {
  for (const p of provisions) {
    insertProvision.run(
      p.sourcebook_id,
      p.reference,
      p.title,
      p.text,
      p.type,
      p.status,
      p.effective_date,
      p.chapter,
      p.section,
    );
  }
});

insertAll();
console.log(`Inserted ${provisions.length} sample provisions`);

// --- Sample enforcement actions ---

interface EnforcementRow {
  firm_name: string;
  reference_number: string;
  action_type: string;
  amount: number;
  date: string;
  summary: string;
  sourcebook_references: string;
}

const enforcements: EnforcementRow[] = [
  {
    firm_name: "OTP Bank Nyrt.",
    reference_number: "H-EN-I-B-135/2021",
    action_type: "fine",
    amount: 800_000_000,
    date: "2021-11-12",
    summary:
      "Az MNB 800 millio forintos birsagot szabott ki az OTP Bank Nyrt.-re sulyos penzmosamellenes folyamatvezerlesi hianossagok miatt. A bank elmulasztotta megfeleloen ellenorizni a nagy osszegu tranzakciokat, es a gyanus tranzakciojelentesi rendszere nem mukodott megfeleloen.",
    sourcebook_references: "MNB ajanlas 3/2022, MNB rendelet 9/2018",
  },
  {
    firm_name: "Erste Bank Hungary Zrt.",
    reference_number: "H-EN-I-B-47/2023",
    action_type: "fine",
    amount: 300_000_000,
    date: "2023-06-20",
    summary:
      "Az MNB 300 millio forintos birsagot szabott ki az Erste Bank Hungary Zrt.-re IT rendszerbiztonsagi es incidens-bejelentesi kovetelmenyek megszegeseerrt. A bank elmulasztotta az elort ido (4 oran belul) ertesitesi kovetelmenyt ket sulos kiberbiztonsagi esemeny soran.",
    sourcebook_references: "MNB ajanlas 7/2021, MNB VK 2/2023",
  },
];

const insertEnforcement = db.prepare(`
  INSERT INTO enforcement_actions (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertEnforcementsAll = db.transaction(() => {
  for (const e of enforcements) {
    insertEnforcement.run(
      e.firm_name,
      e.reference_number,
      e.action_type,
      e.amount,
      e.date,
      e.summary,
      e.sourcebook_references,
    );
  }
});

insertEnforcementsAll();
console.log(`Inserted ${enforcements.length} sample enforcement actions`);

// --- Summary ---

const provisionCount = (
  db.prepare("SELECT count(*) as cnt FROM provisions").get() as { cnt: number }
).cnt;
const sourcebookCount = (
  db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as { cnt: number }
).cnt;
const enforcementCount = (
  db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as { cnt: number }
).cnt;
const ftsCount = (
  db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as { cnt: number }
).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Sourcebooks:          ${sourcebookCount}`);
console.log(`  Provisions:           ${provisionCount}`);
console.log(`  Enforcement actions:  ${enforcementCount}`);
console.log(`  FTS entries:          ${ftsCount}`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
