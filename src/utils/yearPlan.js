// The TFNN year plan: health, feed and breeding jobs for each month, for cattle, sheep and goats.
// A farmer only sees the jobs for the species they keep. Months are 1 (January) to 12 (December).
//
// This is a general guide for a summer-rainfall farm in Namibia. It never gives a dose: the dose
// depends on the product label and the animal's weight, so every treatment job says to follow the
// label or the vet. Items marked `std: true` are standard veterinary practice rather than Namibian
// rules, and the app tells the farmer to confirm timings with the state vet.

const SPECIES = ['Cattle', 'Sheep', 'Goat'];
const CATEGORIES = ['Vaccination', 'Deworming', 'Ticks', 'Feed', 'Breeding'];
const ALL = SPECIES;
const SMALL = ['Sheep', 'Goat'];
const CATTLE = ['Cattle'];

const WET = [10, 11, 12, 1, 2, 3, 4, 5]; // October to May
const DRY = [6, 7, 8, 9];

// [id, species, months, category, title, note]
const ITEMS = [
  // ---- Vaccination ----
  ['anthrax', ALL, [9, 10, 11], 'Vaccination', 'Anthrax vaccination (compulsory, once a year)', 'Do it before the rains. Your vet or the state vet gives the date for your area. Never open an animal you think died of anthrax.'],
  ['lsd', CATTLE, [9, 10, 11], 'Vaccination', 'Lumpy skin disease vaccination', 'Once a year before the rains, and control biting flies. Cattle showing signs may not be moved.'],
  ['botulism', ALL, [9, 10, 11], 'Vaccination', 'Botulism vaccination', 'Once a year. Most important where animals chew bones because the veld is short of phosphorus.'],
  ['blackquarter', CATTLE, [9, 10], 'Vaccination', 'Blackquarter booster (calves from 3 to 4 months, then every year)', 'Often given together with other clostridial vaccines.'],
  ['fmd-cbpp', ALL, [3, 9], 'Vaccination', 'Foot and mouth and lung sickness (CBPP): vaccinate on the dates the Directorate of Veterinary Services announces', 'Applies in the zones where DVS runs campaigns. Follow the movement permit rules.'],
  ['brucellosis', CATTLE, [2, 5], 'Vaccination', 'Brucellosis vaccination for heifer calves of 4 to 8 months (compulsory)', 'Given only by the state vet or an authorised vet.'],
  ['pulpy-dams', SMALL, [3, 4], 'Vaccination', 'Pulpy kidney booster for ewes and does, 4 to 6 weeks before they give birth', 'This also protects the newborns through the first weeks.', true],
  ['pulpy-young', SMALL, [6, 7], 'Vaccination', 'Pulpy kidney first vaccination for lambs and kids from 6 to 8 weeks', 'Needs a booster; follow the vaccine leaflet.', true],
  ['pasteurella', ALL, [4, 7], 'Vaccination', 'Pasteurellosis (pneumonia) vaccine before weaning, transport or sale', 'Stress brings it on, so vaccinate before moving or weaning.', true],
  ['chlamydia', SMALL, [11], 'Vaccination', 'Chlamydiosis (abortion) vaccine before breeding, if you have had abortions', 'Ask your vet whether you need it.', true],
  ['rvf', ALL, [9, 10], 'Vaccination', 'Ask your vet about Rift Valley fever vaccine before the rains', 'More important in wet years. Your vet decides for pregnant animals.', true],

  // ---- Deworming ----
  ['famacha', SMALL, [10, 11, 12, 1, 2, 3, 4], 'Deworming', 'Check eyelid colour (FAMACHA) every 2 weeks and treat only the pale animals', 'Treating only the animals that need it slows worm resistance. Follow the product label for the dose.'],
  ['worm-dams', SMALL, [4], 'Deworming', 'Worm treatment for ewes and does 2 to 4 weeks before they give birth', 'Weigh first and follow the product label.', true],
  ['worm-weaning-small', SMALL, [9], 'Deworming', 'Weigh and treat lambs and kids for worms at weaning', 'Follow the product label for their weight.', true],
  ['worm-calves', CATTLE, [4, 5], 'Deworming', 'Worm treatment for calves and weaners at weaning', 'Weigh first and follow the label. Adult cattle need treatment only when thin, anaemic or stressed.', true],
  ['worm-calves-rain', CATTLE, [11], 'Deworming', 'Worm treatment for weaners once early in the rains', 'Follow the label. Change the product group from time to time.', true],

  // ---- Ticks ----
  ['dip-wet', CATTLE, WET, 'Ticks', 'Dip or spray every 2 weeks (rainy season)', 'In areas with many ticks. Rotate product groups and keep to the label withdrawal period before slaughter. Avoid routine dipping of calves under 4 to 6 months.'],
  ['dip-dry', CATTLE, DRY, 'Ticks', 'Dip or spray every 3 weeks (dry season)', 'Dip early in spring, when tick numbers start to climb.'],
  ['ticks-small', SMALL, [3, 7, 11], 'Ticks', 'Check sheep and goats for ticks, lice and mites and treat if you find them', 'Sheep scab must be reported to the state vet.', true],

  // ---- Feed ----
  ['lick-summer', ALL, [12, 1, 2, 3, 4], 'Feed', 'Keep the summer lick (salt and phosphate) out', 'Many soils lack phosphorus, so green grass alone is not enough. Follow the bag for how much to put out.'],
  ['lick-winter', ALL, [5, 6, 7], 'Feed', 'Start the winter lick (protein) and vitamin A', 'Dry grass loses protein and vitamin A. Follow the bag for how much to put out.'],
  ['lick-energy', ALL, [8, 9, 10], 'Feed', 'Add energy to the protein lick, hay or crop residues if grazing is short', 'These are the hardest months, and cows are in late pregnancy.'],
  ['trace', ALL, [10], 'Feed', 'Trace-mineral injection if your vet or feed adviser recommends it', 'Minerals are poorly absorbed from feed on limestone soils.', true],
  ['lick-switch', ALL, [11], 'Feed', 'Switch to the summer lick when the first rains come', 'Watch cattle for bloat on fresh green grass.'],
  ['feed-cows', CATTLE, [6, 7, 8], 'Feed', 'Extra feed for cows in the last 3 months of pregnancy', 'Check body condition and feed thin cows first.', true],
  ['feed-ewes', SMALL, [3, 4], 'Feed', 'Extra feed for ewes and does in the last 6 weeks of pregnancy', 'Helps the lambs and kids be born strong.', true],

  // ---- Breeding (sheep and goats; cattle breeding jobs are in the general farm jobs list) ----
  ['fert-small', SMALL, [11], 'Breeding', 'Check rams and bucks: body condition, feet and a vet fertility check', 'Do it 4 to 6 weeks before breeding.', true],
  ['join-small', SMALL, [12], 'Breeding', 'Put rams and bucks with the ewes and does (breeding window December to January)', 'Write down the date. It gives you the birth dates.', true],
  ['remove-small', SMALL, [2], 'Breeding', 'Take rams and bucks out of the flock', 'Keeping the window short makes births come close together.', true],
  ['preg-small', SMALL, [4], 'Breeding', 'Pregnancy check 60 to 90 days after the rams and bucks left', 'Cull empty ewes and does.', true],
  ['birth-small', SMALL, [5, 6], 'Breeding', 'Lambing and kidding: check newborns, keep them dry and out of the cold, record the births', 'Winter births need shelter from cold nights.', true],
  ['wean-small', SMALL, [9], 'Breeding', 'Wean lambs and kids at 3 to 4 months', 'Weigh and sort for sale or keep as replacements.', true],
];

const PLAN = ITEMS.map(([id, species, months, category, title, note, std]) => ({
  id, species, months, category, title, note: note || '', std: !!std,
}));

// The items for one month, for the given species. Pass species as an array of normalised names
// (Cattle, Sheep, Goat). A farm with none of these three gets an empty list.
function planForMonth(month, species) {
  const have = new Set(species);
  return PLAN
    .filter((p) => p.months.includes(month) && p.species.some((s) => have.has(s)))
    .sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category))
    .map((p) => ({ id: p.id, category: p.category, title: p.title, note: p.note, std: p.std }));
}

// The whole year: [{ month: 1, items: [...] }, ... 12 entries].
function planForYear(species) {
  return Array.from({ length: 12 }, (_, i) => ({ month: i + 1, items: planForMonth(i + 1, species) }));
}

module.exports = { SPECIES, CATEGORIES, PLAN, planForMonth, planForYear };
