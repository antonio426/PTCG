import { trainerEffects } from '../game/effects/trainers';
import { abilityEffects } from '../game/effects/abilities';
import fs from 'fs';
import path from 'path';

const scratch = process.env.SCRATCH_DIR || '.';
const usedAbilities: [string, number][] = JSON.parse(fs.readFileSync(path.join(scratch, 'used-abilities.json'), 'utf8'));
const usedTrainers: [string, number][] = JSON.parse(fs.readFileSync(path.join(scratch, 'used-trainers.json'), 'utf8'));
const coveredAbilities = new Set(Object.keys(abilityEffects));
const coveredTrainers = new Set(Object.keys(trainerEffects));
const missingAbilities = usedAbilities.filter(([n]) => !coveredAbilities.has(n)).sort((a, b) => b[1] - a[1]);
const missingTrainers = usedTrainers.filter(([n]) => !coveredTrainers.has(n)).sort((a, b) => b[1] - a[1]);
console.log(`=== Missing abilities used in decks (${missingAbilities.length}/${usedAbilities.length}) ===`);
missingAbilities.forEach(([n, c]) => console.log(c, n));
console.log(`=== Missing trainers used in decks (${missingTrainers.length}/${usedTrainers.length}) ===`);
missingTrainers.forEach(([n, c]) => console.log(c, n));
