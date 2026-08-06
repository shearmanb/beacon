// Brad's A1–A10 target list, offered as a one-click starter on /unicorn when
// the bottle list is empty. Kept as plain data (not a seed migration) so it is
// never written behind his back and never has to be deleted from serve.ts
// later — he loads it once, then owns it.

export interface StarterBottle {
  id: string;
  rank: string;
  name: string;
  why: string;
  targetLowDollars: number | null;
  targetHighDollars: number | null;
  maxHammerDollars: number | null;
  notes: string;
  links: Array<{ label: string; url: string }>;
}

export const STARTER_BOTTLES: StarterBottle[] = [
  {
    id: "a1",
    rank: "A1",
    name: "Early Baker's 7 Year, 107 proof — original small-batch bottle, preferably B-85/B-90-era",
    why: "Probably the purest match: old-school Beam nuttiness, caramel, dense body, char and enough proof. Much less trophy inflation than Booker's. An older B-85-001 recently hammered for £95 overseas.",
    targetLowDollars: 175,
    targetHighDollars: 325,
    maxHammerDollars: 225,
    notes: "Best actual buy (B1).",
    links: [],
  },
  {
    id: "a2",
    rank: "A2",
    name: 'Booker\'s 2015-03 "Center Cut"',
    why: "Modern dusty rather than truly antique, but almost engineered for you: official notes specify deep vanilla, nuts, oak, caramel, smoke and a long sweet finish.",
    targetLowDollars: 350,
    targetHighDollars: 475,
    maxHammerDollars: 340,
    notes: "",
    links: [],
  },
  {
    id: "a3",
    rank: "A3",
    name: "Old Grand-Dad 86 proof, National Distillers, 750 ml — approximately 1978–1987",
    why: "Your affordable doorway into the ND OGD profile: butterscotch, rich corn sweetness, old oak and some vintage funk. Lower proof is the compromise. Look for the 86259 UPC prefix rather than Beam's 80686.",
    targetLowDollars: 325,
    targetHighDollars: 475,
    maxHammerDollars: 350,
    notes: "Best true dusty experience (B2). Verify UPC prefix 86259, not 80686.",
    links: [],
  },
  {
    id: "a4",
    rank: "A4",
    name: "Virgin Bourbon 7 Year, 101 proof — 1990s bottle",
    why: "A sleeper pre-fire Heaven Hill target: proper age, proper proof, classic bourbon sweetness and substantially less collector tax than famous HH labels. The 7/101 was a Heaven Hill regional release before losing its age statement.",
    targetLowDollars: 125,
    targetHighDollars: 275,
    maxHammerDollars: 175,
    notes: "Best actual buy (B1).",
    links: [],
  },
  {
    id: "a5",
    rank: "A5",
    name: "Old Heaven Hill 6 Year Bottled-in-Bond — bottle dated 1990s through roughly 2002",
    why: "Pre-fire HH distillate, 100 proof, caramelized sweetness, tobacco, char and old-rickhouse character. More aligned than Old Fitzgerald because it should have more structure and less soft wheater sweetness.",
    targetLowDollars: 250,
    targetHighDollars: 425,
    maxHammerDollars: 300,
    notes: "Best true dusty experience (B2).",
    links: [],
  },
  {
    id: "a6",
    rank: "A6",
    name: 'Quail Creek 8 Year "101" Japanese Export — 1990s Heaven Hill',
    why: "An obscure pre-fire HH export with the exact 8-year/101-proof architecture you want. One recently hammered at $405, so you need a slightly soft auction to keep it below $500 all-in.",
    targetLowDollars: 400,
    targetHighDollars: 475,
    maxHammerDollars: 350,
    notes: "Stretch target (B3) — only below a $350 hammer.",
    links: [],
  },
  {
    id: "a7",
    rank: "A7",
    name: "Old Taylor 6 Year, 86 proof — 1982–1985 National Distillers",
    why: "Sweeter and rounder than its proof suggests, with old caramel, vanilla, corn and dusty oak. It lacks your desired viscosity, but the underlying ND character makes it worth targeting. Auction estimates have been around $250–$350 hammer.",
    targetLowDollars: 275,
    targetHighDollars: 425,
    maxHammerDollars: 300,
    notes: "",
    links: [],
  },
  {
    id: "a8",
    rank: "A8",
    name: "Wild Turkey 8 Year 101 — Austin Nichols, approximately 1990–1997",
    why: "Dense old Turkey, tobacco, leather, dark caramel and rickhouse funk. Ranked lower because vintage Turkey can carry more dried fruit and spice than you prefer. A recent example hammered at $440.",
    targetLowDollars: 425,
    targetHighDollars: 475,
    maxHammerDollars: 350,
    notes: "Stretch target (B3) — only below a $350 hammer.",
    links: [],
  },
  {
    id: "a9",
    rank: "A9",
    name: "J.W. Dant Bottled-in-Bond — 1990s, 750 ml or 1 L",
    why: "Pre-fire Heaven Hill at 100 proof without the Elijah Craig premium. Corny, caramel-forward, straightforward and potentially funky.",
    targetLowDollars: 200,
    targetHighDollars: 375,
    maxHammerDollars: 250,
    notes: "Do NOT confuse with modern Dant, which is merely decent bottom-shelf bourbon.",
    links: [],
  },
  {
    id: "a10",
    rank: "A10",
    name: 'Elijah Craig 12 Year "Pirate Bottle" — preferably early-2000s bottling',
    why: "Excellent value access to older Heaven Hill: substantial age, dark caramel, tobacco and mature oak. Only 94 proof, and barrel variation can drift fruity or overly woody, so this is more bottle-dependent. Comparable EC12 bottles have recently sold around $125–$205 hammer.",
    targetLowDollars: 150,
    targetHighDollars: 275,
    maxHammerDollars: 190,
    notes: "Best actual buy (B1).",
    links: [],
  },
];

export const STARTER_NOTES = [
  "B1 — Best actual buys: Baker's, Virgin 7/101 and early Elijah Craig 12.",
  "B2 — Best true dusty experience: OGD 86 National Distillers or Old Heaven Hill BIB.",
  "B3 — Best stretch targets: Quail Creek 8/101 and Wild Turkey 8/101 — but only below a $350 hammer.",
  "B4 — Verify the liquid: exact bottle year, UPC/DSP, proof, size and export label matter more than the brand name.",
  "B5 — Condition: require a solid fill, clear whiskey, intact closure and no evidence of seepage. A low-fill $300 dusty is not a bargain.",
  "B6 — Skip: ordinary dusty decanters, soft Old Fitzgerald/Weller, low-proof Stitzel-Weller trophies, and anything priced primarily for the label.",
].join("\n");
