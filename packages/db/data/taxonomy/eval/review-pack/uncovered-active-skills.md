# Fixture review pack — uncovered active skills

26 skills reachable through an active edge that **no fixture case has ever asked for**.
Recall figures reported today say nothing about any of them.

## How to use this

1. Read the skill, its real aliases, and the skills nearest to it in the vector space.
2. Answer the evidence questions — several will turn out to be taxonomy problems, not eval gaps.
3. Fill each empty **slot** with a phrase a worker would actually say, avoiding the existing
   aliases verbatim, and set `review_status` to `reviewed`.
4. Leave anything you are unsure about as `pending_review`. It stays out of every metric.

`mechanical` cases need no review. They are also nearly worthless as evidence — the query is
the skill's own alias, so it cannot be wrong. They are here to show reachability only.

---

## Arc welding

- **skill_id**: `skill_arc_welding`  ·  **status**: active
- **domains**: `jd_isco_7213`, `jd_nco_7126_0301`, `jd_nco_7212_0301`, `jd_nco_7224_0102`
- **existing aliases (3)**: `arc welding`, `SMAW`, `stick welding`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.8405 | `skill_mig_welding` | GMAW |
| 0.7864 | `skill_tig_welding` | TIG welding |
| 0.6832 | `skill_gas_cutting` | oxy-fuel cutting |
| 0.6627 | `skill_distortion_control_in_weldments` | वेल्ड विकृति रोकना |

**Evidence needed from you**

- [ ] Confirm "Arc welding" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] No Hindi/Devanagari alias. Supply the term workers use on the shop floor, or record that the English term is what is actually spoken.
- [ ] Is "GMAW" (skill_mig_welding, cosine 0.8405) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "TIG welding" (skill_tig_welding, cosine 0.7864) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Reachable in 4 domains (jd_isco_7213, jd_nco_7126_0301, jd_nco_7212_0301, jd_nco_7224_0102). Confirm the skill means the same thing in each; if not, it needs one case per domain.

**Proposed cases**

- `MX-arc_welding-1` · mechanical · exact_alias · query: `arc welding`
- `MX-arc_welding-2` · mechanical · exact_alias · query: `SMAW`
- `PR-arc_welding-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-arc_welding-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## Bench fitting

- **skill_id**: `skill_bench_fitting`  ·  **status**: active
- **domains**: `jd_isco_7233`, `jd_nco_7224_0102`, `jd_nco_7231_0100`, `jd_nco_7231_0400`, `jd_nco_7233_0101`, `jd_nco_8211_1200`
- **existing aliases (3)**: `bench fitting`, `fitting`, `fitting ka kaam` (hi)

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.7366 | `skill_bearing_replacement` | बेयरिंग फिटिंग |
| 0.7146 | `skill_grinding_ops` | ghisai ka kaam |
| 0.7062 | `skill_structural_fit_up_and_tacking` | fit up and tack |
| 0.6884 | `skill_machine_maintenance` | machine ki marammat |

**Evidence needed from you**

- [ ] Confirm "Bench fitting" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Is "बेयरिंग फिटिंग" (skill_bearing_replacement, cosine 0.7366) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "ghisai ka kaam" (skill_grinding_ops, cosine 0.7146) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Reachable in 6 domains (jd_isco_7233, jd_nco_7224_0102, jd_nco_7231_0100, jd_nco_7231_0400, jd_nco_7233_0101, jd_nco_8211_1200). Confirm the skill means the same thing in each; if not, it needs one case per domain.

**Proposed cases**

- `MX-bench_fitting-1` · mechanical · exact_alias · query: `bench fitting`
- `MX-bench_fitting-2` · mechanical · exact_alias · query: `fitting`
- `PR-bench_fitting-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-bench_fitting-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## Boring

- **skill_id**: `skill_boring`  ·  **status**: active
- **domains**: `jd_nco_7223_0701`
- **existing aliases (1)**: `boring`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.7556 | `skill_drilling` | drilling |
| 0.6652 | `skill_turning` | turning |
| 0.6366 | `skill_tapping_threading` | tapping |
| 0.6208 | `skill_deburring` | deburring |

**Evidence needed from you**

- [ ] Confirm "Boring" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Only 1 alias(es) exist. Decide whether that is genuinely the whole vocabulary for this skill, or whether the paraphrase case is about to measure a gap in the corpus rather than a gap in retrieval.
- [ ] No Hindi/Devanagari alias. Supply the term workers use on the shop floor, or record that the English term is what is actually spoken.
- [ ] Is "drilling" (skill_drilling, cosine 0.7556) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "turning" (skill_turning, cosine 0.6652) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.

**Proposed cases**

- `MX-boring-1` · mechanical · exact_alias · query: `boring`
- `PR-boring-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-boring-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## CAD / technical drawing interpretation

- **skill_id**: `skill_cad_interpretation`  ·  **status**: active
- **domains**: `jd_isco_7213`, `jd_nco_7223_6003`, `jd_nco_7224_0102`, `jd_nco_7231_0400`, `jd_nco_7412_0200`, `jd_nco_8211_1200`
- **existing aliases (4)**: `CAD`, `drawing padhna` (hi), `read engineering drawings`, `technical drawing`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.7985 | `skill_gdt_reading` | blueprint reading |
| 0.6812 | `skill_cam_software` | CAM software |
| 0.6332 | `skill_cnc_programming` | CNC programming |
| 0.6258 | `skill_sheet_metal_marking_and_layout` | marking and layout |

**Evidence needed from you**

- [ ] Confirm "CAD / technical drawing interpretation" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Is "blueprint reading" (skill_gdt_reading, cosine 0.7985) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "CAM software" (skill_cam_software, cosine 0.6812) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Reachable in 6 domains (jd_isco_7213, jd_nco_7223_6003, jd_nco_7224_0102, jd_nco_7231_0400, jd_nco_7412_0200, jd_nco_8211_1200). Confirm the skill means the same thing in each; if not, it needs one case per domain.

**Proposed cases**

- `MX-cad_interpretation-1` · mechanical · exact_alias · query: `CAD`
- `MX-cad_interpretation-2` · mechanical · devanagari_alias · query: `drawing padhna`
- `PR-cad_interpretation-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-cad_interpretation-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## CAM software (Mastercam/Fusion/etc.)

- **skill_id**: `skill_cam_software`  ·  **status**: active
- **domains**: `jd_nco_7223_6003`
- **existing aliases (3)**: `CAM software`, `Fusion 360`, `Mastercam`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.6868 | `skill_milling` | CNC milling |
| 0.6866 | `skill_cnc_programming` | CNC programming |
| 0.6812 | `skill_cad_interpretation` | CAD |
| 0.6795 | `skill_fanuc` | Fanuc |

**Evidence needed from you**

- [ ] Confirm "CAM software (Mastercam/Fusion/etc.)" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] No Hindi/Devanagari alias. Supply the term workers use on the shop floor, or record that the English term is what is actually spoken.
- [ ] Is "CNC milling" (skill_milling, cosine 0.6868) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "CNC programming" (skill_cnc_programming, cosine 0.6866) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.

**Proposed cases**

- `MX-cam_software-1` · mechanical · exact_alias · query: `CAM software`
- `MX-cam_software-2` · mechanical · exact_alias · query: `Fusion 360`
- `PR-cam_software-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-cam_software-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## CMM operation

- **skill_id**: `skill_cmm`  ·  **status**: active
- **domains**: `jd_nco_7543_2001`
- **existing aliases (2)**: `CMM`, `coordinate measuring machine`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.7008 | `skill_dimensional_inspection` | dimensional inspection |
| 0.6643 | `skill_gdt_reading` | geometric dimensioning and tolerancing |
| 0.6554 | `skill_measuring_instruments` | vernier caliper |
| 0.6424 | `skill_go_no_go_gauge_checking` | plug gauge check |

**Evidence needed from you**

- [ ] Confirm "CMM operation" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Only 2 alias(es) exist. Decide whether that is genuinely the whole vocabulary for this skill, or whether the paraphrase case is about to measure a gap in the corpus rather than a gap in retrieval.
- [ ] No Hindi/Devanagari alias. Supply the term workers use on the shop floor, or record that the English term is what is actually spoken.
- [ ] Is "dimensional inspection" (skill_dimensional_inspection, cosine 0.7008) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "geometric dimensioning and tolerancing" (skill_gdt_reading, cosine 0.6643) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.

**Proposed cases**

- `MX-cmm-1` · mechanical · exact_alias · query: `CMM`
- `MX-cmm-2` · mechanical · exact_alias · query: `coordinate measuring machine`
- `PR-cmm-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-cmm-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## Deburring / finishing

- **skill_id**: `skill_deburring`  ·  **status**: active
- **domains**: `jd_isco_7213`, `jd_nco_7223_0701`, `jd_nco_7223_2400`
- **existing aliases (4)**: `chhilai` (hi), `deburring`, `finishing`, `finishing ka kaam` (hi)

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.7298 | `skill_drilling` | drilling ka kaam |
| 0.7029 | `skill_sheet_metal` | chadar ka kaam |
| 0.6871 | `skill_machine_maintenance` | machine ki marammat |
| 0.6782 | `skill_turning` | kharad ka kaam |

**Evidence needed from you**

- [ ] Confirm "Deburring / finishing" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Is "drilling ka kaam" (skill_drilling, cosine 0.7298) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "chadar ka kaam" (skill_sheet_metal, cosine 0.7029) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Reachable in 3 domains (jd_isco_7213, jd_nco_7223_0701, jd_nco_7223_2400). Confirm the skill means the same thing in each; if not, it needs one case per domain.

**Proposed cases**

- `MX-deburring-1` · mechanical · devanagari_alias · query: `chhilai`
- `MX-deburring-2` · mechanical · exact_alias · query: `deburring`
- `PR-deburring-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-deburring-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## Drilling

- **skill_id**: `skill_drilling`  ·  **status**: active
- **domains**: `jd_nco_7223_0701`
- **existing aliases (3)**: `chhed karna` (hi), `drilling`, `drilling ka kaam` (hi)

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.7556 | `skill_boring` | boring |
| 0.7298 | `skill_deburring` | finishing ka kaam |
| 0.6993 | `skill_tapping_threading` | chudi katna |
| 0.6921 | `skill_turning` | kharad ka kaam |

**Evidence needed from you**

- [ ] Confirm "Drilling" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Is "boring" (skill_boring, cosine 0.7556) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "finishing ka kaam" (skill_deburring, cosine 0.7298) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.

**Proposed cases**

- `MX-drilling-1` · mechanical · devanagari_alias · query: `chhed karna`
- `MX-drilling-2` · mechanical · exact_alias · query: `drilling`
- `PR-drilling-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-drilling-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## Fixture / job setup

- **skill_id**: `skill_fixture_setup`  ·  **status**: active
- **domains**: `jd_nco_7223_6002`
- **existing aliases (5)**: `fixture setup`, `job setting` (hi), `job setup`, `setting karna` (hi), `workholding`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.6879 | `skill_tool_offset_setting` | offset setting |
| 0.6427 | `skill_gdt_reading` | GD&T |
| 0.6409 | `skill_program_editing` | program sudharna |
| 0.6192 | `skill_machine_maintenance` | machine ki marammat |

**Evidence needed from you**

- [ ] Confirm "Fixture / job setup" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Is "offset setting" (skill_tool_offset_setting, cosine 0.6879) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "GD&T" (skill_gdt_reading, cosine 0.6427) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.

**Proposed cases**

- `MX-fixture_setup-1` · mechanical · exact_alias · query: `fixture setup`
- `MX-fixture_setup-2` · mechanical · devanagari_alias · query: `job setting`
- `PR-fixture_setup-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-fixture_setup-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## Gas cutting

- **skill_id**: `skill_gas_cutting`  ·  **status**: active
- **domains**: `jd_isco_7213`, `jd_nco_7126_0301`, `jd_nco_7212_0100`, `jd_nco_7212_0301`, `jd_nco_7224_0102`
- **existing aliases (3)**: `gas cutting`, `gas se katna` (hi), `oxy-fuel cutting`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.7379 | `skill_tapping_threading` | chudi katna |
| 0.7016 | `skill_oxy_acetylene_cylinder_handling` | गैस सिलेंडर |
| 0.6832 | `skill_arc_welding` | arc welding |
| 0.6729 | `skill_mig_welding` | MIG/MAG |

**Evidence needed from you**

- [ ] Confirm "Gas cutting" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Is "chudi katna" (skill_tapping_threading, cosine 0.7379) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "गैस सिलेंडर" (skill_oxy_acetylene_cylinder_handling, cosine 0.7016) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Reachable in 5 domains (jd_isco_7213, jd_nco_7126_0301, jd_nco_7212_0100, jd_nco_7212_0301, jd_nco_7224_0102). Confirm the skill means the same thing in each; if not, it needs one case per domain.

**Proposed cases**

- `MX-gas_cutting-1` · mechanical · exact_alias · query: `gas cutting`
- `MX-gas_cutting-2` · mechanical · devanagari_alias · query: `gas se katna`
- `PR-gas_cutting-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-gas_cutting-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## GD&T / drawing reading

- **skill_id**: `skill_gdt_reading`  ·  **status**: active
- **domains**: `jd_nco_7126_0301`, `jd_nco_7212_0301`, `jd_nco_7223_0701`, `jd_nco_7223_6002`, `jd_nco_7223_6003`, `jd_nco_7224_0102`, `jd_nco_7313_2601`, `jd_nco_7543_2001`
- **existing aliases (4)**: `blueprint reading`, `drawing reading`, `GD&T`, `geometric dimensioning and tolerancing`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.7985 | `skill_cad_interpretation` | read engineering drawings |
| 0.7570 | `skill_dimensional_inspection` | dimensional inspection |
| 0.6692 | `skill_tig_welding` | GTAW |
| 0.6643 | `skill_cmm` | coordinate measuring machine |

**Evidence needed from you**

- [ ] Confirm "GD&T / drawing reading" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] No Hindi/Devanagari alias. Supply the term workers use on the shop floor, or record that the English term is what is actually spoken.
- [ ] Is "read engineering drawings" (skill_cad_interpretation, cosine 0.7985) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "dimensional inspection" (skill_dimensional_inspection, cosine 0.7570) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Reachable in 8 domains (jd_nco_7126_0301, jd_nco_7212_0301, jd_nco_7223_0701, jd_nco_7223_6002, jd_nco_7223_6003, jd_nco_7224_0102, jd_nco_7313_2601, jd_nco_7543_2001). Confirm the skill means the same thing in each; if not, it needs one case per domain.

**Proposed cases**

- `MX-gdt_reading-1` · mechanical · exact_alias · query: `blueprint reading`
- `MX-gdt_reading-2` · mechanical · exact_alias · query: `drawing reading`
- `PR-gdt_reading-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-gdt_reading-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## Grinding (surface / cylindrical)

- **skill_id**: `skill_grinding_ops`  ·  **status**: active
- **domains**: `jd_nco_7212_0100`, `jd_nco_7212_0301`, `jd_nco_7224_0102`
- **existing aliases (5)**: `cylindrical grinding`, `ghisai` (hi), `ghisai ka kaam` (hi), `grinding`, `surface grinding`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.7146 | `skill_bench_fitting` | fitting ka kaam |
| 0.6629 | `skill_oxy_acetylene_cylinder_handling` | cylinder handling |
| 0.6371 | `skill_weld_spatter_cleaning` | छींटे साफ करना |
| 0.6263 | `skill_welding_joint_preparation` | joint preparation |

**Evidence needed from you**

- [ ] Confirm "Grinding (surface / cylindrical)" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Is "fitting ka kaam" (skill_bench_fitting, cosine 0.7146) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "cylinder handling" (skill_oxy_acetylene_cylinder_handling, cosine 0.6629) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Reachable in 3 domains (jd_nco_7212_0100, jd_nco_7212_0301, jd_nco_7224_0102). Confirm the skill means the same thing in each; if not, it needs one case per domain.

**Proposed cases**

- `MX-grinding_ops-1` · mechanical · exact_alias · query: `cylindrical grinding`
- `MX-grinding_ops-2` · mechanical · devanagari_alias · query: `ghisai`
- `PR-grinding_ops-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-grinding_ops-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## Hydraulics / pneumatics

- **skill_id**: `skill_hydraulics_pneumatics`  ·  **status**: active
- **domains**: `jd_isco_7233`, `jd_nco_7231_0100`, `jd_nco_7233_0101`
- **existing aliases (2)**: `hydraulics`, `pneumatics`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.6223 | `skill_pump_and_valve_repair` | pump repair |
| 0.5893 | `skill_suspension_and_steering_repair` | suspension repair |
| 0.5830 | `skill_machine_maintenance` | preventive maintenance |
| 0.5811 | `skill_brake_system_servicing` | ब्रेक ठीक करना |

**Evidence needed from you**

- [ ] Confirm "Hydraulics / pneumatics" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Only 2 alias(es) exist. Decide whether that is genuinely the whole vocabulary for this skill, or whether the paraphrase case is about to measure a gap in the corpus rather than a gap in retrieval.
- [ ] No Hindi/Devanagari alias. Supply the term workers use on the shop floor, or record that the English term is what is actually spoken.
- [ ] Is "pump repair" (skill_pump_and_valve_repair, cosine 0.6223) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "suspension repair" (skill_suspension_and_steering_repair, cosine 0.5893) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Reachable in 3 domains (jd_isco_7233, jd_nco_7231_0100, jd_nco_7233_0101). Confirm the skill means the same thing in each; if not, it needs one case per domain.

**Proposed cases**

- `MX-hydraulics_pneumat-1` · mechanical · exact_alias · query: `hydraulics`
- `MX-hydraulics_pneumat-2` · mechanical · exact_alias · query: `pneumatics`
- `PR-hydraulics_pneumat-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-hydraulics_pneumat-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## Machine maintenance

- **skill_id**: `skill_machine_maintenance`  ·  **status**: active
- **domains**: `jd_isco_7233`, `jd_nco_7212_0300`, `jd_nco_7223_2400`, `jd_nco_7223_6002`, `jd_nco_7233_0101`
- **existing aliases (3)**: `machine ki marammat` (hi), `maintenance`, `preventive maintenance`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.6919 | `skill_punching_machine_operation` | पंच मशीन |
| 0.6884 | `skill_bench_fitting` | fitting ka kaam |
| 0.6871 | `skill_deburring` | finishing ka kaam |
| 0.6844 | `skill_pump_and_valve_repair` | वाल्व ठीक करना |

**Evidence needed from you**

- [ ] Confirm "Machine maintenance" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Is "पंच मशीन" (skill_punching_machine_operation, cosine 0.6919) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "fitting ka kaam" (skill_bench_fitting, cosine 0.6884) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Reachable in 5 domains (jd_isco_7233, jd_nco_7212_0300, jd_nco_7223_2400, jd_nco_7223_6002, jd_nco_7233_0101). Confirm the skill means the same thing in each; if not, it needs one case per domain.

**Proposed cases**

- `MX-machine_maintenanc-1` · mechanical · devanagari_alias · query: `machine ki marammat`
- `MX-machine_maintenanc-2` · mechanical · exact_alias · query: `maintenance`
- `PR-machine_maintenanc-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-machine_maintenanc-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## Micrometer / Vernier / gauge usage

- **skill_id**: `skill_measuring_instruments`  ·  **status**: active
- **domains**: `jd_isco_7213`, `jd_nco_7223_0701`, `jd_nco_7223_2400`, `jd_nco_7223_6002`, `jd_nco_7224_0102`, `jd_nco_7231_0400`, `jd_nco_7233_0101`, `jd_nco_7313_2601`, `jd_nco_7543_2001`
- **existing aliases (6)**: `gauge`, `measuring instruments`, `micrometer`, `micrometer se naapna` (hi), `naap tol` (hi), `vernier caliper`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.7933 | `skill_go_no_go_gauge_checking` | गेज से जांच |
| 0.7579 | `skill_sheet_metal_marking_and_layout` | नाप लगाना |
| 0.6554 | `skill_cmm` | coordinate measuring machine |
| 0.6532 | `skill_dimensional_inspection` | dimensional inspection |

**Evidence needed from you**

- [ ] Confirm "Micrometer / Vernier / gauge usage" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Is "गेज से जांच" (skill_go_no_go_gauge_checking, cosine 0.7933) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "नाप लगाना" (skill_sheet_metal_marking_and_layout, cosine 0.7579) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Reachable in 9 domains (jd_isco_7213, jd_nco_7223_0701, jd_nco_7223_2400, jd_nco_7223_6002, jd_nco_7224_0102, jd_nco_7231_0400, jd_nco_7233_0101, jd_nco_7313_2601, jd_nco_7543_2001). Confirm the skill means the same thing in each; if not, it needs one case per domain.

**Proposed cases**

- `MX-measuring_instrume-1` · mechanical · exact_alias · query: `gauge`
- `MX-measuring_instrume-2` · mechanical · exact_alias · query: `measuring instruments`
- `PR-measuring_instrume-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-measuring_instrume-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## Mechanical assembly

- **skill_id**: `skill_mechanical_assembly`  ·  **status**: active
- **domains**: `jd_nco_7231_0400`, `jd_nco_8211_1200`, `jd_nco_8212_0100`
- **existing aliases (2)**: `assembly`, `mechanical assembly`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.7570 | `skill_chassis_fitting` | chassis assembly |
| 0.7108 | `skill_sub_assembly_quality_checking` | sub assembly check |
| 0.6419 | `skill_fastener_selection_and_tightening` | fastener tightening |
| 0.6225 | `skill_bench_fitting` | fitting |

**Evidence needed from you**

- [ ] Confirm "Mechanical assembly" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Only 2 alias(es) exist. Decide whether that is genuinely the whole vocabulary for this skill, or whether the paraphrase case is about to measure a gap in the corpus rather than a gap in retrieval.
- [ ] No Hindi/Devanagari alias. Supply the term workers use on the shop floor, or record that the English term is what is actually spoken.
- [ ] Is "chassis assembly" (skill_chassis_fitting, cosine 0.7570) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "sub assembly check" (skill_sub_assembly_quality_checking, cosine 0.7108) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Reachable in 3 domains (jd_nco_7231_0400, jd_nco_8211_1200, jd_nco_8212_0100). Confirm the skill means the same thing in each; if not, it needs one case per domain.

**Proposed cases**

- `MX-mechanical_assembl-1` · mechanical · exact_alias · query: `assembly`
- `MX-mechanical_assembl-2` · mechanical · exact_alias · query: `mechanical assembly`
- `PR-mechanical_assembl-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-mechanical_assembl-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## MIG welding

- **skill_id**: `skill_mig_welding`  ·  **status**: active
- **domains**: `jd_nco_7212_0300`, `jd_nco_7212_0301`
- **existing aliases (3)**: `GMAW`, `MIG/MAG`, `MIG welding`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.8405 | `skill_arc_welding` | SMAW |
| 0.8355 | `skill_tig_welding` | GTAW |
| 0.6729 | `skill_gas_cutting` | oxy-fuel cutting |
| 0.6371 | `skill_distortion_control_in_weldments` | वेल्ड विकृति रोकना |

**Evidence needed from you**

- [ ] Confirm "MIG welding" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] No Hindi/Devanagari alias. Supply the term workers use on the shop floor, or record that the English term is what is actually spoken.
- [ ] Is "SMAW" (skill_arc_welding, cosine 0.8405) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "GTAW" (skill_tig_welding, cosine 0.8355) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Reachable in 2 domains (jd_nco_7212_0300, jd_nco_7212_0301). Confirm the skill means the same thing in each; if not, it needs one case per domain.

**Proposed cases**

- `MX-mig_welding-1` · mechanical · exact_alias · query: `GMAW`
- `MX-mig_welding-2` · mechanical · exact_alias · query: `MIG/MAG`
- `PR-mig_welding-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-mig_welding-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## Milling

- **skill_id**: `skill_milling`  ·  **status**: active
- **domains**: `jd_nco_7223_6003`
- **existing aliases (3)**: `CNC milling`, `milling`, `VMC operation`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.7313 | `skill_cnc_programming` | CNC programming |
| 0.6868 | `skill_cam_software` | CAM software |
| 0.6242 | `skill_fanuc` | Fanuc controller |
| 0.6232 | `skill_gdt_reading` | GD&T |

**Evidence needed from you**

- [ ] Confirm "Milling" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] No Hindi/Devanagari alias. Supply the term workers use on the shop floor, or record that the English term is what is actually spoken.
- [ ] Is "CNC programming" (skill_cnc_programming, cosine 0.7313) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "CAM software" (skill_cam_software, cosine 0.6868) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.

**Proposed cases**

- `MX-milling-1` · mechanical · exact_alias · query: `CNC milling`
- `MX-milling-2` · mechanical · exact_alias · query: `milling`
- `PR-milling-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-milling-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## Mitsubishi control operation

- **skill_id**: `skill_mitsubishi`  ·  **status**: active
- **domains**: `jd_nco_7223_6003`
- **existing aliases (2)**: `Mitsubishi`, `Mitsubishi controller`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.7650 | `skill_fanuc` | Fanuc controller |
| 0.6501 | `skill_siemens` | Siemens |
| 0.6188 | `skill_program_editing` | M-code |
| 0.6171 | `skill_cam_software` | Mastercam |

**Evidence needed from you**

- [ ] Confirm "Mitsubishi control operation" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Only 2 alias(es) exist. Decide whether that is genuinely the whole vocabulary for this skill, or whether the paraphrase case is about to measure a gap in the corpus rather than a gap in retrieval.
- [ ] No Hindi/Devanagari alias. Supply the term workers use on the shop floor, or record that the English term is what is actually spoken.
- [ ] Is "Fanuc controller" (skill_fanuc, cosine 0.7650) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "Siemens" (skill_siemens, cosine 0.6501) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.

**Proposed cases**

- `MX-mitsubishi-1` · mechanical · exact_alias · query: `Mitsubishi`
- `MX-mitsubishi-2` · mechanical · exact_alias · query: `Mitsubishi controller`
- `PR-mitsubishi-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-mitsubishi-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## Program editing (G & M codes)

- **skill_id**: `skill_program_editing`  ·  **status**: active
- **domains**: `jd_nco_7223_6002`, `jd_nco_7223_6003`
- **existing aliases (4)**: `G-code editing`, `M-code`, `program editing`, `program sudharna` (hi)

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.7315 | `skill_cnc_programming` | part programming |
| 0.6409 | `skill_fixture_setup` | setting karna |
| 0.6188 | `skill_mitsubishi` | Mitsubishi |
| 0.6171 | `skill_cad_interpretation` | drawing padhna |

**Evidence needed from you**

- [ ] Confirm "Program editing (G & M codes)" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Is "part programming" (skill_cnc_programming, cosine 0.7315) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "setting karna" (skill_fixture_setup, cosine 0.6409) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Reachable in 2 domains (jd_nco_7223_6002, jd_nco_7223_6003). Confirm the skill means the same thing in each; if not, it needs one case per domain.

**Proposed cases**

- `MX-program_editing-1` · mechanical · exact_alias · query: `G-code editing`
- `MX-program_editing-2` · mechanical · exact_alias · query: `M-code`
- `PR-program_editing-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-program_editing-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## Quality control (QC)

- **skill_id**: `skill_quality_control`  ·  **status**: active
- **domains**: `jd_nco_7313_2601`
- **existing aliases (3)**: `QC`, `quality check karna` (hi), `quality control`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.8219 | `skill_dimensional_inspection` | quality check |
| 0.6953 | `skill_surface_finish_inspection` | surface finish check |
| 0.6939 | `skill_visual_defect_identification` | आंख से जांच |
| 0.6671 | `skill_go_no_go_gauge_checking` | गेज से जांच |

**Evidence needed from you**

- [ ] Confirm "Quality control (QC)" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Is "quality check" (skill_dimensional_inspection, cosine 0.8219) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "surface finish check" (skill_surface_finish_inspection, cosine 0.6953) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.

**Proposed cases**

- `MX-quality_control-1` · mechanical · exact_alias · query: `QC`
- `MX-quality_control-2` · mechanical · devanagari_alias · query: `quality check karna`
- `PR-quality_control-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-quality_control-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## Sheet-metal fabrication

- **skill_id**: `skill_sheet_metal`  ·  **status**: active
- **domains**: `jd_isco_7213`, `jd_nco_7223_2400`
- **existing aliases (3)**: `chadar ka kaam` (hi), `fabrication`, `sheet metal`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.7029 | `skill_deburring` | finishing ka kaam |
| 0.6609 | `skill_press_brake_bending` | press brake operation |
| 0.6487 | `skill_punching_machine_operation` | punching operation |
| 0.6356 | `skill_shearing_machine_operation` | shearing operation |

**Evidence needed from you**

- [ ] Confirm "Sheet-metal fabrication" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Is "finishing ka kaam" (skill_deburring, cosine 0.7029) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "press brake operation" (skill_press_brake_bending, cosine 0.6609) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Reachable in 2 domains (jd_isco_7213, jd_nco_7223_2400). Confirm the skill means the same thing in each; if not, it needs one case per domain.

**Proposed cases**

- `MX-sheet_metal-1` · mechanical · devanagari_alias · query: `chadar ka kaam`
- `MX-sheet_metal-2` · mechanical · exact_alias · query: `fabrication`
- `PR-sheet_metal-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-sheet_metal-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## Siemens control operation

- **skill_id**: `skill_siemens`  ·  **status**: active
- **domains**: `jd_nco_7223_6002`, `jd_nco_7223_6003`
- **existing aliases (2)**: `Siemens`, `Sinumerik`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.7193 | `skill_fanuc` | Fanuc |
| 0.6501 | `skill_mitsubishi` | Mitsubishi |
| 0.6433 | `skill_cam_software` | Mastercam |
| 0.6418 | `skill_cnc_programming` | CNC programming |

**Evidence needed from you**

- [ ] Confirm "Siemens control operation" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Only 2 alias(es) exist. Decide whether that is genuinely the whole vocabulary for this skill, or whether the paraphrase case is about to measure a gap in the corpus rather than a gap in retrieval.
- [ ] No Hindi/Devanagari alias. Supply the term workers use on the shop floor, or record that the English term is what is actually spoken.
- [ ] Is "Fanuc" (skill_fanuc, cosine 0.7193) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "Mitsubishi" (skill_mitsubishi, cosine 0.6501) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Reachable in 2 domains (jd_nco_7223_6002, jd_nco_7223_6003). Confirm the skill means the same thing in each; if not, it needs one case per domain.

**Proposed cases**

- `MX-siemens-1` · mechanical · exact_alias · query: `Siemens`
- `MX-siemens-2` · mechanical · exact_alias · query: `Sinumerik`
- `PR-siemens-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-siemens-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## Tapping / threading

- **skill_id**: `skill_tapping_threading`  ·  **status**: active
- **domains**: `jd_nco_7126_0301`, `jd_nco_7223_0701`
- **existing aliases (3)**: `chudi katna` (hi), `tapping`, `threading`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.7379 | `skill_gas_cutting` | gas se katna |
| 0.6993 | `skill_drilling` | chhed karna |
| 0.6650 | `skill_lathe_chuck_mounting` | चक कसना |
| 0.6534 | `skill_turning` | turning |

**Evidence needed from you**

- [ ] Confirm "Tapping / threading" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Is "gas se katna" (skill_gas_cutting, cosine 0.7379) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "chhed karna" (skill_drilling, cosine 0.6993) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Reachable in 2 domains (jd_nco_7126_0301, jd_nco_7223_0701). Confirm the skill means the same thing in each; if not, it needs one case per domain.

**Proposed cases**

- `MX-tapping_threading-1` · mechanical · devanagari_alias · query: `chudi katna`
- `MX-tapping_threading-2` · mechanical · exact_alias · query: `tapping`
- `PR-tapping_threading-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-tapping_threading-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## Tool offset setting

- **skill_id**: `skill_tool_offset_setting`  ·  **status**: active
- **domains**: `jd_nco_7223_6002`, `jd_nco_7223_6003`
- **existing aliases (2)**: `offset setting`, `tool offset`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.6879 | `skill_fixture_setup` | job setting |
| 0.6328 | `skill_cutting_tool_selection` | टूल चुनना |
| 0.6207 | `skill_cnc_programming` | CNC programming |
| 0.6180 | `skill_cam_software` | CAM software |

**Evidence needed from you**

- [ ] Confirm "Tool offset setting" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Only 2 alias(es) exist. Decide whether that is genuinely the whole vocabulary for this skill, or whether the paraphrase case is about to measure a gap in the corpus rather than a gap in retrieval.
- [ ] No Hindi/Devanagari alias. Supply the term workers use on the shop floor, or record that the English term is what is actually spoken.
- [ ] Is "job setting" (skill_fixture_setup, cosine 0.6879) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "टूल चुनना" (skill_cutting_tool_selection, cosine 0.6328) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Reachable in 2 domains (jd_nco_7223_6002, jd_nco_7223_6003). Confirm the skill means the same thing in each; if not, it needs one case per domain.

**Proposed cases**

- `MX-tool_offset_settin-1` · mechanical · exact_alias · query: `offset setting`
- `MX-tool_offset_settin-2` · mechanical · exact_alias · query: `tool offset`
- `PR-tool_offset_settin-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-tool_offset_settin-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---

## Turning (lathe operation)

- **skill_id**: `skill_turning`  ·  **status**: active
- **domains**: `jd_nco_7223_0701`, `jd_nco_7223_6002`
- **existing aliases (5)**: `CNC turning`, `kharad` (hi), `kharad ka kaam` (hi), `lathe operation`, `turning`

**Nearest other skills in a shared domain** — what a careless phrasing would hit:

| cosine | skill | via alias |
|---|---|---|
| 0.6921 | `skill_drilling` | drilling ka kaam |
| 0.6782 | `skill_deburring` | finishing ka kaam |
| 0.6652 | `skill_boring` | boring |
| 0.6577 | `skill_lathe_chuck_mounting` | चक कसना |

**Evidence needed from you**

- [ ] Confirm "Turning (lathe operation)" is the phrase a worker or supervisor would actually use. If the catalogue label is jargon, the alias set is what needs fixing, not the fixture.
- [ ] Is "drilling ka kaam" (skill_drilling, cosine 0.6921) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Is "finishing ka kaam" (skill_deburring, cosine 0.6782) a DIFFERENT skill or the same work under another name? If the same, this is a taxonomy merge, not an eval case. If different, say what distinguishes them so the paraphrase can be written to separate them.
- [ ] Reachable in 2 domains (jd_nco_7223_0701, jd_nco_7223_6002). Confirm the skill means the same thing in each; if not, it needs one case per domain.

**Proposed cases**

- `MX-turning-1` · mechanical · exact_alias · query: `CNC turning`
- `MX-turning-2` · mechanical · devanagari_alias · query: `kharad`
- `PR-turning-1` · pending_review · paraphrase_latin · **query: _______________________ (write it)**
- `PR-turning-2` · pending_review · devanagari_paraphrase · **query: _______________________ (write it)**

---
