# Referencia de Debilidades (weak points) de Monstruos — Sword World 2.5

## Estado del documento

**Tipo:** Investigación y documentación únicamente. No se ha modificado código, datos de monstruos, compendios ni archivos de `sw25-library`.
**Versión del sistema:** Sword World 2.5 Foundry v0.16.2 (Foundry VTT v14)
**Fecha del análisis:** 2026-11-04
**Fuentes primarias:** inventario completo de los 711 (712) monstruos de `sw25-library` documentado en `docs/sw25-monster-weakness-extraction.json`; reglas oficiales verificadas directamente sobre los PDF de `D:\Foundry Assets\Sword-World-Sources\` (Core Rulebook I/II, Abyss Breaker, Ancient Blue, Monstrous Lore, Battle Mastery); verificación puntual de páginas del wiki fuente (`sw25.wikidot.com`).
**Alcance:** Este documento actualiza y sustituye la versión anterior de `docs/monster-weakness-reference.md` (basada en solo 4 monstruos de fixture). Ahora cubre el 100 % del inventario con verificación de reglas RAW.

---

## 0. Resumen ejecutivo

1. Se extrajeron y verificaron los 712 monstruos del inventario (11 packs de tipo Actor de `sw25-library`). Existen **77 valores literales** de `weakPoint` que se agrupan en **14 categorías mecánicas**.
2. Bajo RAW, las debilidades son **efectos que aumentan el daño** que se aplican **antes** de la reducción por Defense (CR I, pp. 134–136), y el conocimiento de debilidades expira con la sesión (CR I, p. 383; Ancient Blue, p. 21).
3. La implementación actual del sistema solo soporta de punta a punta 2 de las 14 categorías: **FÍSICO (132)** y **MAGIA (65 de 76)** → **197 de 712 (27,7 %)**. El parser de texto cubre 497/712 (69,8 %) y el resto exige mejoras de normalización.
4. **49 monstruos** tienen `weakness = 0`: 48 con `weakPoint = "None"` (44 humanoids + 2 constructs + Familiars I/II del pack magitech) y 1 (`Magireplica`, también del pack magitech) con debilidad fija de plantilla `※/※`. El `0` procede del parser (`monster-parser.mjs:23,151,408`) cuando el wiki omite el umbral o muestra `-` o `※` (el guion `-` es la forma impresa de "sin debilidad", cfr. AB pp. 127–129).
5. Se documentaron discrepancias del sistema con RAW: orden defensa/bonus, restricción de clasificación del Dark Hunter, expiración por sesión, Weakness Exploit, `Accuracy +1` y los 9 tipos tipados no mapeados.
6. **Estado del módulo de conocimiento:** `module/combat/monster-knowledge.mjs` contiene un error de sintaxis (falla `node --check`) y mismatches de exports con sus importadores (`sw25.mjs`, `monster-sheet.mjs`); no se reparó por decisión del usuario.

---

## 1. Cobertura del inventario y validación de datos

### 1.1 Fuente de datos

- **Archivo:** `D:\Foundry Assets\sword-world-25\docs\sw25-monster-weakness-extraction.json`
- **Registros:** 712, con `errors: []` (0 errores de extracción) y `extractedAt: 2026-11-04T00:01:55.446Z`.
- **Origen de cada registro:** los Actors de 11 packs de compendio de `sw25-library` (formato LevelDB), leídos con Python sobre los `.ldb`. Cada monstruo conserva su `sourceUrl` del wiki: `https://sw25.wikidot.com/monster:<slug>`.

### 1.2 Packs analizados

| Pack | Monstruos |
|------|-----------|
| `monsters-animals` | 83 |
| `monsters-barbarous` | 155 |
| `monsters-constructs` | 62 |
| `monsters-daemons` | 61 |
| `monsters-fairies` | 49 |
| `monsters-golems` | 16 |
| `monsters-humanoids` | 46 |
| `monsters-magitech` | 51 |
| `monsters-mythical-beasts` | 62 |
| `monsters-plants` | 48 |
| `monsters-undead` | 79 |
| **Total** | **712** |

### 1.3 Validaciones realizadas

- La suma de los conteos por categoría (sección 2) es exactamente **712**.
- Cada valor literal de `weakPoint` fue contado individualmente: **77 valores únicos** en total (sección 3).
- Rangos de datos del inventario: **11 packs**, 712 registros, 0 errores; reputation: 0–26; weakness: 0–33 (9–33 excluyendo los 49 con `0`).

---

## 2. Tabla de categorías y frecuencias

Las 77 variantes literales se agrupan en **14 categorías mecánicas** según el tipo interviniente y la magnitud:

| Categoría | Monstruos | % | Parseable | Mapeado al sistema | Valor literal de ejemplo |
|-----------|----------:|---:|----------:|-------------------:|--------------------------|
| **FÍSICO** | 132 | 18,5 % | 132 | 132 | `Physical damage +2 points` (101×) |
| **MAGIA** | 76 | 10,7 % | 65 | 65 | `Magic damage +2 points` (42×) |
| **PRECISIÓN** | 69 | 9,7 % | 69 | 0 | `Accuracy +1` (69×) |
| **FUEGO** | 117 | 16,4 % | 116 | 0 | `Fire damage +3 points` (57×) |
| **AGUA/HIELO** | 43 | 6,0 % | 0 | 0 | `Water/Ice damage +3 points` (23×) |
| **CURACIÓN COMO DAÑO** | 43 | 6,0 % | 0 | 0 | `HP Recovery (deals damage instead), +3 points` (23×) |
| **CONTUNDENTE** | 36 | 5,1 % | 23 | 0 | `Bludgeoning damage +3 points` (15×) |
| **VIENTO** | 33 | 4,6 % | 12 | 0 | `Wind type damage +3 points` (14×) |
| **CORTANTE** | 28 | 3,9 % | 12 | 0 | `Slashing damage +3 points` (9×) |
| **RAYO** | 27 | 3,8 % | 27 | 0 | `Lightning damage +3 points` (17×) |
| **TIERRA** | 26 | 3,7 % | 26 | 0 | `Earth damage + 3 points` (16×) |
| **ENERGÍA** | 23 | 3,2 % | 15 | 0 | `Energy damage +3 points` (12×) |
| **PLATA** | 11 | 1,5 % | 0 | 0 | `Silver Weapon Damage +3` (6×) |
| **NONE** | 48 | 6,7 % | 0 | 0 | `None` (48×) |
| **Total** | **712** | **100 %** | **497** | **197** | **77 variantes** |

### 2.1 Magnitudes observadas

| Categoría | Magnitudes observadas |
|-----------|----------------------|
| FÍSICO | +2 (131), +3 (1 — Hydra) |
| MAGIA | +2 (76) |
| PRECISIÓN | +1 (69) |
| FUEGO, AGUA/HIELO, VIENTO, CORTANTE, RAYO, TIERRA, ENERGÍA, CONTUNDENTE | +3 |
| PLATA | +3 (contra armas plateadas) |
| CURACIÓN COMO DAÑO | +3 (42), +4 (1 — Dragon Zombie) |

La magnitud **no cambia la semántica**: es la cantidad del efecto. El tipo sí determina con qué se compara (ver sección 6).

---

## 3. Catálogo de los 77 valores literales de `weakPoint`

Tabla completa de valores literales tal como están almacenados en los datos de los Actors (sin normalizar), con su categoría y frecuencia:

#### FÍSICO (132 monstruos, 6 variantes)

| Valor literal | Frecuencia | ¿Parsea? |
|---------------|-----------:|----------|
| `Physical damage +2 points` | 101 | sí |
| `Physical Damage +2` | 22 | sí |
| `Physical damage +2` | 4 | sí |
| `Physical Damage +2 points` | 3 | sí |
| `Physical Damage +2 Points` | 1 | sí |
| `Physical damage +3 points` | 1 | sí |

#### MAGIA (76 monstruos, 7 variantes)

| Valor literal | Frecuencia | ¿Parsea? |
|---------------|-----------:|----------|
| `Magic damage +2 points` | 42 | sí |
| `Magic Damage +2` | 11 | sí |
| `+2 Magic Damage` | 10 | no |
| `Magic Damage +2 points` | 9 | sí |
| `Magic damage +2` | 2 | sí |
| `+2 Magic damage` | 1 | no |
| `Magic Damage +2 Points` | 1 | sí |

#### PRECISIÓN (69 monstruos, 1 variantes)

| Valor literal | Frecuencia | ¿Parsea? |
|---------------|-----------:|----------|
| `Accuracy +1` | 69 | sí |

#### FUEGO (117 monstruos, 7 variantes)

| Valor literal | Frecuencia | ¿Parsea? |
|---------------|-----------:|----------|
| `Fire damage +3 points` | 57 | sí |
| `Fire damage + 3 points` | 35 | sí |
| `Fire Damage +3` | 13 | sí |
| `Fire damage +3` | 6 | sí |
| `Fire Damage +3 points` | 4 | sí |
| `Fire &amp; Earth damage + 3 points` | 1 | no |
| `Fire damage +3 damage` | 1 | sí (sin mapeo) |

#### AGUA/HIELO (43 monstruos, 5 variantes)

| Valor literal | Frecuencia | ¿Parsea? |
|---------------|-----------:|----------|
| `Water/Ice damage +3 points` | 23 | no |
| `Water/Ice damage + 3 points` | 14 | no |
| `Water/Ice Damage +3` | 4 | no |
| `Water/Ice +3 Damage` | 1 | no |
| `Water/ice damage +3 points` | 1 | no |

#### CURACIÓN COMO DAÑO (43 monstruos, 10 variantes)

| Valor literal | Frecuencia | ¿Parsea? |
|---------------|-----------:|----------|
| `HP Recovery (deals damage instead), +3 points` | 23 | no |
| `HP Recovery (deals damage instead) +3 points` | 6 | no |
| `HP Recovery (when deals damage) +3 points` | 3 | no |
| `HP Recovery Damage +3 points` | 3 | no |
| `HP Recovery (deals damage instead) +3` | 2 | no |
| `HP Recovery damage +3 points` | 2 | no |
| `HP Recovery (Deals damage instead) +3` | 1 | no |
| `HP Recovery (deals damage instead), +3` | 1 | no |
| `HP Recovery (deals damage instead), +4 points` | 1 | no |
| `HP Recovery Damage (when deals damage), +3 points` | 1 | no |

#### CONTUNDENTE (36 monstruos, 8 variantes)

| Valor literal | Frecuencia | ¿Parsea? |
|---------------|-----------:|----------|
| `Bludgeoning damage +3 points` | 15 | sí |
| `Bludgeoning type damage +3 points` | 9 | no |
| `Bludgeoning Damage +3` | 4 | sí |
| `Bludgeoning damage +3` | 3 | sí |
| `Bludgeoning type damage +3` | 2 | no |
| `Bludgeoning Damage +3 points` | 1 | sí |
| `Bludgeoning-type Damage +3` | 1 | no |
| `Bludgeoning-type damage +3 points` | 1 | no |

#### VIENTO (33 monstruos, 9 variantes)

| Valor literal | Frecuencia | ¿Parsea? |
|---------------|-----------:|----------|
| `Wind type damage +3 points` | 14 | no |
| `Wind damage +3 points` | 8 | sí |
| `Wind Damage +3` | 4 | sí |
| `Wind-type damage +3 points` | 2 | no |
| `Wind-type +3 damage` | 1 | no |
| `Wind-type +3 Damage` | 1 | no |
| `Wind-type Damage +3` | 1 | no |
| `Wind-type damage +3` | 1 | no |
| `Wind-type Damage +3 points` | 1 | no |

#### CORTANTE (28 monstruos, 6 variantes)

| Valor literal | Frecuencia | ¿Parsea? |
|---------------|-----------:|----------|
| `Slashing damage +3 points` | 9 | sí |
| `Slashing type damage +3 points` | 8 | no |
| `Slashing type damage +3` | 5 | no |
| `Slashing damage +3` | 3 | sí |
| `Slashing-type Damage +3` | 2 | no |
| `Slashing-type damage +3 points` | 1 | no |

#### RAYO (27 monstruos, 5 variantes)

| Valor literal | Frecuencia | ¿Parsea? |
|---------------|-----------:|----------|
| `Lightning damage +3 points` | 17 | sí |
| `Lightning damage + 3 points` | 6 | sí |
| `Lightning damage + 3` | 2 | sí |
| `Lightning Damage +3` | 1 | sí |
| `Lightning damage +3 damage` | 1 | sí (sin mapeo) |

#### TIERRA (26 monstruos, 4 variantes)

| Valor literal | Frecuencia | ¿Parsea? |
|---------------|-----------:|----------|
| `Earth damage + 3 points` | 16 | sí |
| `Earth damage +3 points` | 6 | sí |
| `Earth Damage +3` | 3 | sí |
| `Earth Damage + 3 points` | 1 | sí |

#### ENERGÍA (23 monstruos, 6 variantes)

| Valor literal | Frecuencia | ¿Parsea? |
|---------------|-----------:|----------|
| `Energy damage +3 points` | 12 | sí |
| `Energy type damage +3 points` | 4 | no |
| `+3 Energy damage` | 2 | no |
| `Energy damage +3` | 2 | sí |
| `Energy type damage +3` | 2 | no |
| `Energy Damage +3 points` | 1 | sí |

#### PLATA (11 monstruos, 2 variantes)

| Valor literal | Frecuencia | ¿Parsea? |
|---------------|-----------:|----------|
| `Silver Weapon Damage +3` | 6 | no |
| `Silver weapon damage +3 points` | 5 | no |

#### NONE (48 monstruos, 1 variantes)

| Valor literal | Frecuencia | ¿Parsea? |
|---------------|-----------:|----------|
| `None` | 48 | — |


### 3.1 Explicación de las variantes

Las 77 variantes son esencialmente **pocas mecánicas con muchas variaciones tipográficas**, procedentes del wiki fuente y del formato impreso de los manuales:

1. **Espaciado:** `"Fire damage + 3 points"` vs `"Fire damage +3 points"` — espacio extra antes del número.
2. **Capitalización:** `damage`/`Damage`; `points`/`Points`; y formas sin unidad (`"Fire Damage +3"`).
3. **Inserto `type`:** `"Bludgeoning type damage +3 points"`, `"Wind type damage +3 points"`, `"Slashing type damage +3 points"`, `"Energy type damage +3 points"` (equivalen a la forma sin `type`).
4. **Guion en `type`:** `"Wind-type damage +3 points"`, `"Slashing-type Damage +3"`, `"Bludgeoning-type Damage +3"` etc.
5. **Barra `/` en tipo:** `"Water/Ice damage +3 points"` (agua/hielo es un **único tipo** en SW2.5, cf. tabla de tipos AB p. 41) — incluye una variante en minúsculas (`"Water/ice damage +3 points"`).
6. **Orden invertido:** `"+2 Magic Damage"` y `"+2 Magic damage"` (cantidad y tipo al revés que en el resto de variantes), y `"Water/Ice +3 Damage"`, `"Wind-type +3 damage"`, `"+3 Energy damage"`.
7. **Sufijo duplicado:** `"Fire damage +3 damage"` (Green Torch) y `"Lightning damage +3 damage"` (Magireplica) — repiten `damage` al final; el valor mecánico es el de la serie normal.
8. **Doble tipo con entidad HTML sin decodificar:** `"Fire &amp; Earth damage + 3 points"` (Skadi) — dos tipos unidos con `&amp;`; anomalía de codificación en el wiki.
9. **Frase variable de "HP Recovery" (10 formas):** núcleo `"HP Recovery ... +3 points"` con paréntesis y sufijos variables: `(deals damage instead)`, `(when deals damage)`, `HP Recovery Damage`, `HP Recovery damage`, con o sin coma; la excepción es `+4 points` (Dragon Zombie). RAW: aparece textual de estas formas en los bloques de monstruos de Abyss Breaker (p. ej. AB pp. 97–101, 139: `"Weak Point: HP Recovery Damage (when deals damage), +3 points"`).
10. **`"None"`:** 48 bloques sin debilidad (impreso como `Weak Point: None`, AB pp. 127–129).

---

## 4. Listado completo por efecto (712 monstruos)

Tablas por categoría → variante literal con: ID del Actor, pack, `reputation/weakness` del inventario y URL del wiki.

### FÍSICO (132)

#### `Physical damage +2 points` — 101 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Dark Sweeper | `VZlMMlb21iBG6rK4` | `monsters-animals` | 12/15 | https://sw25.wikidot.com/monster:dark-sweeper |
| Giant Gadfly | `pDI9LrIjM7YbB3pr` | `monsters-animals` | 6/9 | https://sw25.wikidot.com/monster:giant-gadfly |
| Giant Lizard | `alNWHFRURq6DVYfJ` | `monsters-animals` | 7/11 | https://sw25.wikidot.com/monster:giant-lizard |
| Hammerhead Leech | `gaQbvP9z1HSSjPxW` | `monsters-animals` | 10/13 | https://sw25.wikidot.com/monster:hammerhead-leech |
| Murder Hornet | `u0g4D0FocsJTyegO` | `monsters-animals` | 17/20 | https://sw25.wikidot.com/monster:murder-hornet |
| Pack Leader | `KKtMoJNmxsVlhf9l` | `monsters-animals` | 8/11 | https://sw25.wikidot.com/monster:pack-leader |
| Petroviper | `70dQ6FLyUawadXij` | `monsters-animals` | 10/14 | https://sw25.wikidot.com/monster:petroviper |
| Plain Centipede | `dBZT6YKk6X0qiqLp` | `monsters-animals` | 13/16 | https://sw25.wikidot.com/monster:plain-centipede |
| Sharp Nails | `Lwftjw5sS5Z5qW4h` | `monsters-animals` | 11/14 | https://sw25.wikidot.com/monster:sharp-nails |
| Wolf | `7JcXVZiy7M5BSkCR` | `monsters-animals` | 5/10 | https://sw25.wikidot.com/monster:wolf |
| Androscorpion | `aQgPQ5cbdTyvirup` | `monsters-barbarous` | 12/15 | https://sw25.wikidot.com/monster:androscorpion |
| Bolg | `2trOZNeij15YYr6k` | `monsters-barbarous` | 7/13 | https://sw25.wikidot.com/monster:bolg |
| Bolg Assassinator | `B92CQLdzjTtNtNao` | `monsters-barbarous` | 15/19 | https://sw25.wikidot.com/monster:bolg-assassinator |
| Bolg Heavy Arm | `hQ2NwRRZdJU8lCXm` | `monsters-barbarous` | 10/15 | https://sw25.wikidot.com/monster:bolg-heavy-arm |
| Bolg Highlander | `CyCZggqWzO6zgJdm` | `monsters-barbarous` | 9/14 | https://sw25.wikidot.com/monster:bolg-highlander |
| Bolg Suppressor | `mSBMA8Lh5NLZXnZ6` | `monsters-barbarous` | 19/24 | https://sw25.wikidot.com/monster:bolg-suppressor |
| Bolg Thrower | `O9ZIArJQ7EU9MqOP` | `monsters-barbarous` | 9/14 | https://sw25.wikidot.com/monster:bolg-thrower |
| Forest Giant | `mY2mUJDJzHHLw8FB` | `monsters-barbarous` | 15/20 | https://sw25.wikidot.com/monster:forest-giant |
| Hecatoncheires | `uLm0vTuKO5mRav57` | `monsters-barbarous` | 16/22 | https://sw25.wikidot.com/monster:hecatoncheires |
| Hill Giant | `aqNMNxKMJzOFnuPR` | `monsters-barbarous` | 15/18 | https://sw25.wikidot.com/monster:hill-giant |
| Loreley | `lYERX62ZypZELGmg` | `monsters-barbarous` | 10/14 | https://sw25.wikidot.com/monster:loreley |
| Loud Bolg Commander | `km5hFBptRS6jcS3y` | `monsters-barbarous` | 13/18 | https://sw25.wikidot.com/monster:loud-bolg-commander |
| Medusa | `HBvxoOaaK59ZcXut` | `monsters-barbarous` | 10/15 | https://sw25.wikidot.com/monster:medusa |
| Merient Medusa | `0IrGiqsC0Yh31Bfv` | `monsters-barbarous` | 12/15 | https://sw25.wikidot.com/monster:merient-medusa |
| Murcielago | `b1aY0rdDIVcRXIRy` | `monsters-barbarous` | 19/22 | https://sw25.wikidot.com/monster:murcielago |
| Murcielago Latigo | `VkwwWgqfJcPPlIK9` | `monsters-barbarous` | 23/26 | https://sw25.wikidot.com/monster:murcielago-latigo |
| Ogre Warlord | `ven0r4GBEwvKmqNs` | `monsters-barbarous` | 16/20 | https://sw25.wikidot.com/monster:ogre-warlord |
| Scissorscorpion | `UkpNmcJjhSj3t5ms` | `monsters-barbarous` | 13/18 | https://sw25.wikidot.com/monster:scissorscorpion |
| Shard Medusa | `abr1F7FWKsudTjkE` | `monsters-barbarous` | 15/20 | https://sw25.wikidot.com/monster:shard-medusa |
| Tannoz | `BbKhpArFTPWiXqkf` | `monsters-barbarous` | 12/16 | https://sw25.wikidot.com/monster:tannoz |
| Tannoz Cleric | `UaBxM6HLvGgMcK2s` | `monsters-barbarous` | 14/18 | https://sw25.wikidot.com/monster:tannoz-cleric |
| Tannoz Veteran | `P555hZKaN0G49p8V` | `monsters-barbarous` | 16/20 | https://sw25.wikidot.com/monster:tannoz-veteran |
| Tyrant Strider | `oNcmHOhTj3NdfGhy` | `monsters-barbarous` | 14/17 | https://sw25.wikidot.com/monster:tyrant-strider |
| Tyrant Warrior | `OgxiTTf3YlCfrKBa` | `monsters-barbarous` | 12/15 | https://sw25.wikidot.com/monster:tyrant-warrior |
| Zeanemo | `j8KERta1C6LacvQA` | `monsters-barbarous` | 11/13 | https://sw25.wikidot.com/monster:zeanemo |
| Zeanemo Attacker | `b43M9vHwkQgwOhbo` | `monsters-barbarous` | 14/16 | https://sw25.wikidot.com/monster:zeanemo-attacker |
| Zeanemo Master | `dI673MCDuMgZGmLK` | `monsters-barbarous` | 18/20 | https://sw25.wikidot.com/monster:zeanemo-master |
| Zeanemo Shaman | `94UwP5ZVIMp3JJsC` | `monsters-barbarous` | 13/15 | https://sw25.wikidot.com/monster:zeanemo-shaman |
| Alchemy Tooth | `01jxmNqyYq8kkrkq` | `monsters-constructs` | 14/17 | https://sw25.wikidot.com/monster:alchemy-tooth |
| Alert Gramophone | `uaj1ryS9LHc1Q3Jx` | `monsters-constructs` | 15/18 | https://sw25.wikidot.com/monster:alert-gramophone |
| Buckbaird | `Y7sz1PEkmeOl1pPY` | `monsters-constructs` | 18/21 | https://sw25.wikidot.com/monster:buckbaird |
| Carnage Table | `3O2O1ZGy6QSMwAGa` | `monsters-constructs` | 17/20 | https://sw25.wikidot.com/monster:carnage-table |
| Door Imitator | `Oug9HMdvK3bpczYB` | `monsters-constructs` | 9/12 | https://sw25.wikidot.com/monster:door-limiter |
| Dungeon Keeper | `lLdUOpZK4m7lqUpa` | `monsters-constructs` | 10/14 | https://sw25.wikidot.com/monster:dungeon-keeper |
| Ghast | `HS83KoSa38EUqvd8` | `monsters-constructs` | 5/10 | https://sw25.wikidot.com/monster:ghast |
| Ghast Bishop | `ZK64MapnQp5yJfQE` | `monsters-constructs` | 9/15 | https://sw25.wikidot.com/monster:ghast-bishop |
| Ghast King | `gQ0PKH9rhJJshnPi` | `monsters-constructs` | 16/22 | https://sw25.wikidot.com/monster:ghast-king |
| Ghast Knight | `g1lZNQ9Id6LSjw8p` | `monsters-constructs` | 7/13 | https://sw25.wikidot.com/monster:ghast-knight |
| Ghast Lurker | `zCClf6x7JmiJVETU` | `monsters-constructs` | 5/11 | https://sw25.wikidot.com/monster:ghast-lurker |
| Ghast Queen | `7WwuJeLJK4Mqa0iO` | `monsters-constructs` | 13/19 | https://sw25.wikidot.com/monster:ghast-queen |
| Goldface | `WxnIJ8wAzwY5UETr` | `monsters-constructs` | 22/26 | https://sw25.wikidot.com/monster:goldface |
| Homunculus | `NQyi7ai5Ut6ytBNZ` | `monsters-constructs` | 10/15 | https://sw25.wikidot.com/monster:homunculus |
| Malicious Dresser | `ckQ8VE6LKAze1ceP` | `monsters-constructs` | 16/19 | https://sw25.wikidot.com/monster:malicious-dresser |
| Plasma Sphere | `Ybk54s8nk1Zl4T0q` | `monsters-constructs` | 13/16 | https://sw25.wikidot.com/monster:plasma-sphere |
| Sinker House | `EHGXTGQgGHrrYpha` | `monsters-constructs` | 14/18 | https://sw25.wikidot.com/monster:sinker-house |
| Aetherbeast | `jL4WPdchw5V0Hf3F` | `monsters-daemons` | 12/15 | https://sw25.wikidot.com/monster:aetherbeast |
| Aprerousa | `nSeeXfuf6vjz29kg` | `monsters-daemons` | 18/21 | https://sw25.wikidot.com/monster:aprerousa |
| Doubleburg | `EjkTzkhKSLoAU1JP` | `monsters-daemons` | 12/15 | https://sw25.wikidot.com/monster:doubleburg |
| Gannibaso | `fwb0p3Q3ewNCGG16` | `monsters-daemons` | 15/18 | https://sw25.wikidot.com/monster:gannibaso |
| Godbell | `MwKqbaOuXNXbF5O4` | `monsters-daemons` | 16/19 | https://sw25.wikidot.com/monster:godbell |
| Mengle | `EL0De2HzS9TijFTt` | `monsters-daemons` | 8/12 | https://sw25.wikidot.com/monster:mengle |
| Movkira | `CjHxAeEaCmsjawcg` | `monsters-daemons` | 12/16 | https://sw25.wikidot.com/monster:movkira |
| Sakkara | `FQJXJDecEnCrTv45` | `monsters-daemons` | 11/15 | https://sw25.wikidot.com/monster:sakkara |
| Amalthea | `y9fdxHnuHetiXHwJ` | `monsters-fairies` | 19/21 | https://sw25.wikidot.com/monster:amalthea |
| Dunae | `ZFMBcjjxF0q7G0MG` | `monsters-fairies` | 10/15 | https://sw25.wikidot.com/monster:dunae |
| Flabby Golem | `Xo9qzJJKVJEAGyyp` | `monsters-golems` | 10/14 | https://sw25.wikidot.com/monster:flabby-golem |
| Leather Fish | `vEMoS4N1JN1HpL4F` | `monsters-golems` | 12/15 | https://sw25.wikidot.com/monster:leather-fish |
| Barba | `VQi6XaU7TY9vG3n4` | `monsters-magitech` | 11/14 | https://sw25.wikidot.com/monster:barba |
| Colossus: Knight | `rahVXALCGD4OEM69` | `monsters-magitech` | 19/26 | https://sw25.wikidot.com/monster:colossus-knight |
| Colossus: Pawn | `jHe1iqEaIXl3hnqL` | `monsters-magitech` | 16/23 | https://sw25.wikidot.com/monster:colossus-pawn |
| Eltrias | `rkASluLAPKg0jzUB` | `monsters-magitech` | 16/19 | https://sw25.wikidot.com/monster:eltrias |
| Gur Barba | `Bx4Gyne6GftgoryH` | `monsters-magitech` | 13/16 | https://sw25.wikidot.com/monster:gur-barba |
| Maris Barba | `zuD0LzmL8AbyL4Je` | `monsters-magitech` | 15/18 | https://sw25.wikidot.com/monster:maris-barba |
| Railway Cannon | `ZJ4ZEbcddX3dNQoi` | `monsters-magitech` | 11/21 | https://sw25.wikidot.com/monster:railway-cannon |
| Vox Guard | `Sy0HvcKZ3mAaenfz` | `monsters-magitech` | 14/17 | https://sw25.wikidot.com/monster:vox-guard |
| Vox Queen | `wUS6hfNTuENJJhpv` | `monsters-magitech` | 14/17 | https://sw25.wikidot.com/monster:vox-queen |
| Vox Soldier | `O08fIfz4iA5AolN8` | `monsters-magitech` | 13/16 | https://sw25.wikidot.com/monster:vox-soldier |
| Vox Worker | `DgV3H7i2WzTzcPmV` | `monsters-magitech` | 11/14 | https://sw25.wikidot.com/monster:vox-worker |
| Achlis | `tvDNVcnlCY2SRIKB` | `monsters-mythical-beasts` | 9/12 | https://sw25.wikidot.com/monster:achlis |
| Afanc | `JRXrbrf3i0sbWIVy` | `monsters-mythical-beasts` | 10/17 | https://sw25.wikidot.com/monster:afanc |
| Al-Mi'raj | `bqtfJYvAIK1NnF5i` | `monsters-mythical-beasts` | 10/13 | https://sw25.wikidot.com/monster:almiraj |
| Deela Harpy | `uIBQqnBFqLiFYGBZ` | `monsters-mythical-beasts` | 8/14 | https://sw25.wikidot.com/monster:deela-harpy |
| Draconet | `HPdeVJJZ5HgYAjTx` | `monsters-mythical-beasts` | 15/20 | https://sw25.wikidot.com/monster:draconet |
| Dragon Infant | `OqsZKLD5ZXYhC5bj` | `monsters-mythical-beasts` | 12/15 | https://sw25.wikidot.com/monster:dragon-infant |
| Elder Dragon | `WwnpbPYJg5jmYMei` | `monsters-mythical-beasts` | 10/33 | https://sw25.wikidot.com/monster:elder-dragon |
| Greater Dragon | `WZvFr1yRv0chd2hu` | `monsters-mythical-beasts` | 18/24 | https://sw25.wikidot.com/monster:greater-dragon |
| Lesser Dragon | `Hwr5TMN80fhsbqDg` | `monsters-mythical-beasts` | 12/20 | https://sw25.wikidot.com/monster:lesser-dragon |
| Monoceros | `xRxsuQbPRjjJUFLK` | `monsters-mythical-beasts` | 16/19 | https://sw25.wikidot.com/monster:monoceros |
| Myrmecoleon | `jxBDMOd3Dlj6d9nK` | `monsters-mythical-beasts` | 10/15 | https://sw25.wikidot.com/monster:myrmecoleon |
| Phantasmal Butterfly | `awOHNNxcfTU8srCm` | `monsters-mythical-beasts` | 15/18 | https://sw25.wikidot.com/monster:phantasmal-butterfly |
| Python | `1Q9qwJ3oFH0lwuUA` | `monsters-mythical-beasts` | 15/19 | https://sw25.wikidot.com/monster:python |
| Ringing Rain Deer | `0Sy4nLn22IclTpiF` | `monsters-mythical-beasts` | 15/18 | https://sw25.wikidot.com/monster:ringing-rain-deer |
| Sirin | `ks5viseWfY2AOwMA` | `monsters-mythical-beasts` | 10/14 | https://sw25.wikidot.com/monster:sirin |
| Sphinx | `9pJaIk0ztEDXNFbp` | `monsters-mythical-beasts` | 18/25 | https://sw25.wikidot.com/monster:sphinx |
| Tarrasque | `cmlbRcJEOpWNLGHQ` | `monsters-mythical-beasts` | 19/22 | https://sw25.wikidot.com/monster:tarrasque |
| Megalomor | `k67oz2WIIuv4FZUp` | `monsters-plants` | 20/24 | https://sw25.wikidot.com/monster:megalomor |
| Rock Lotus Tree | `BIET9djtQ59tsPQC` | `monsters-plants` | 15/17 | https://sw25.wikidot.com/monster:rock-lotus-tree |
| Stepping Leaf | `QcmhROjlFuZkkbfx` | `monsters-plants` | 11/14 | https://sw25.wikidot.com/monster:stepping-leaf |
| Burning Iceman | `kxJySQJRW2V3fpgD` | `monsters-undead` | 13/17 | https://sw25.wikidot.com/monster:burning-iceman |
| Giant Zombie | `SAyyPhlFdj7sunKA` | `monsters-undead` | 13/20 | https://sw25.wikidot.com/monster:giant-zombie |
| Wraith | `dSpxDKPlWhgVPyJA` | `monsters-undead` | 16/23 | https://sw25.wikidot.com/monster:wraith |

#### `Physical Damage +2` — 22 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Capture Beetle | `H11TCRFf80acsYLg` | `monsters-animals` | 12/14 | https://sw25.wikidot.com/monster:capture-beetle |
| Cetus | `oG9eiyieYN8sF4hn` | `monsters-animals` | 18/21 | https://sw25.wikidot.com/monster:cetus |
| Liger | `RGz8aExnshOwJpht` | `monsters-animals` | 13/17 | https://sw25.wikidot.com/monster:liger |
| Lion | `aULD5ICm7fHg5ga9` | `monsters-animals` | 10/14 | https://sw25.wikidot.com/monster:lion |
| Luana Giant Toad | `gius3qOkE31EJNFC` | `monsters-animals` | 10/13 | https://sw25.wikidot.com/monster:luana-giant-toad |
| White Gold Liger | `Q5KrjPWrHoWbRaws` | `monsters-animals` | 16/19 | https://sw25.wikidot.com/monster:white-gold-liger |
| Areigo | `CUdiyMsW0BX8VMgo` | `monsters-barbarous` | 12/15 | https://sw25.wikidot.com/monster:areigo |
| Areigo Akid | `4gB20QkmVz1tKiRu` | `monsters-barbarous` | 15/18 | https://sw25.wikidot.com/monster:areigo-akid |
| Areigo Daved | `0kvmrWj9jJLqYRz3` | `monsters-barbarous` | 18/21 | https://sw25.wikidot.com/monster:areigo-daved |
| High Goblin | `pbdtuBtBc9xFmL4p` | `monsters-barbarous` | 11/16 | https://sw25.wikidot.com/monster:high-goblin |
| High Goblin Fanatic | `pl0VQ1kgneiyjNaI` | `monsters-barbarous` | 11/16 | https://sw25.wikidot.com/monster:high-goblin-fanatic |
| High Goblin Maiden | `04Z1e9RUVWNPaXof` | `monsters-barbarous` | 15/20 | https://sw25.wikidot.com/monster:high-goblin-maiden |
| High Goblin Raider | `vq9wpm1tQUkelMGy` | `monsters-barbarous` | 12/18 | https://sw25.wikidot.com/monster:high-goblin-raider |
| Ghast Cavalry | `toqghqTVWvsNVYlJ` | `monsters-constructs` | 9/14 | https://sw25.wikidot.com/monster:ghast-cavalry |
| Dusky Grace | `vVH8WpU7A47toWtS` | `monsters-daemons` | 12/17 | https://sw25.wikidot.com/monster:dusky-grace |
| Ergacleo | `NSE3OwyRtpVop1TE` | `monsters-daemons` | 17/20 | https://sw25.wikidot.com/monster:ergacleo |
| Tiki Tiki | `4XJZHBPgcGgkGzJE` | `monsters-daemons` | 17/22 | https://sw25.wikidot.com/monster:tiki-tiki |
| Tikira | `Pg41264NrILFhDkV` | `monsters-daemons` | 15/20 | https://sw25.wikidot.com/monster:tikira |
| Wafushu | `3a4oc1idRSBq9OMf` | `monsters-daemons` | 15/19 | https://sw25.wikidot.com/monster:wafushu |
| Insaid Barba | `l9eJHmblBjSsOjGc` | `monsters-magitech` | 12/15 | https://sw25.wikidot.com/monster:insaid-barba |
| Alraune | `FM98gVKw0QDkvRCp` | `monsters-plants` | 9/12 | https://sw25.wikidot.com/monster:alraune |
| Mandrake | `qURnyGh6Svngt7f8` | `monsters-plants` | 11/16 | https://sw25.wikidot.com/monster:mandrake |

#### `Physical damage +2` — 4 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Purple Ant | `SlwP79Qz1wNhLOrw` | `monsters-animals` | 8/11 | https://sw25.wikidot.com/monster:purple-ant |
| Baba Yaga | `R9brzwU6VsZqasYK` | `monsters-barbarous` | 13/16 | https://sw25.wikidot.com/monster:baba-yaga |
| Baba Yaga Witch | `6UntSzwUlnWgkkOv` | `monsters-barbarous` | 15/18 | https://sw25.wikidot.com/monster:baba-yaga-witch |
| Night Wanderer | `iEhIOLVtqEWe41Bw` | `monsters-plants` | 15/18 | https://sw25.wikidot.com/monster:night-wanderer |

#### `Physical Damage +2 points` — 3 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Desert Scorpion | `HGi6QmvJX8YqRwOK` | `monsters-animals` | 17/20 | https://sw25.wikidot.com/monster:desert-scorpion |
| Scale Flipper | `CdFYkcqE1adfoCuJ` | `monsters-golems` | 12/16 | https://sw25.wikidot.com/monster:scale-flipper |
| Abyssal Lesser Dragon | `pgPLDIuA9fr6squg` | `monsters-mythical-beasts` | 16/21 | https://sw25.wikidot.com/monster:abyssal-lesser-dragon |

#### `Physical Damage +2 Points` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Espiraco | `mzj6cUaA9Wp3vV5i` | `monsters-daemons` | 11/14 | https://sw25.wikidot.com/monster:espiraco |

#### `Physical damage +3 points` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Hydra | `o27svsiypIsWphLh` | `monsters-animals` | 17/20 | https://sw25.wikidot.com/monster:hydra |

### MAGIA (76)

#### `Magic damage +2 points` — 42 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Brafotes | `FfE9vSP8Mvfkt6RD` | `monsters-animals` | 15/18 | https://sw25.wikidot.com/monster:brafotes |
| Crash Bear | `CUABMhq6893omx8y` | `monsters-animals` | 15/18 | https://sw25.wikidot.com/monster:crash-bear |
| Crocodile | `GwutLAOzDcauuL5J` | `monsters-animals` | 12/15 | https://sw25.wikidot.com/monster:crocodile |
| Giant Boar | `wUecZ82ECvtaIgyq` | `monsters-animals` | 16/19 | https://sw25.wikidot.com/monster:giant-bohr |
| Grizzly Bear | `nfw92C2XBTXB4u5O` | `monsters-animals` | 12/16 | https://sw25.wikidot.com/monster:grizzly-bear |
| Shotel Runner | `31RpQ9DioUaqtNsK` | `monsters-animals` | 9/12 | https://sw25.wikidot.com/monster:shotel-runner |
| Tyrant Regilex | `M0T0aoAnh4B7Ow54` | `monsters-animals` | 19/23 | https://sw25.wikidot.com/monster:tyrant-regilex |
| Dark Troll | `gnDimB8CXseIWNjl` | `monsters-barbarous` | 13/18 | https://sw25.wikidot.com/monster:dark-troll |
| Dark Troll Adept | `qMZ31Ka10WQHLWQJ` | `monsters-barbarous` | 15/19 | https://sw25.wikidot.com/monster:dark-troll-adept |
| Drake (Dragon Form) | `laAvu1hr04BeO2O4` | `monsters-barbarous` | 12/18 | https://sw25.wikidot.com/monster:drake-dragon-form |
| Drake (Human Form) | `KGU5quDXKMQTHSkv` | `monsters-barbarous` | 10/17 | https://sw25.wikidot.com/monster:drake-human-form |
| Drake Baron (Dragon Form) | `fQAtluiEqUuQVNuw` | `monsters-barbarous` | 13/20 | https://sw25.wikidot.com/monster:drake-baron-dragon-form |
| Drake Baron (Human Form) | `GVSHyXrQfumATdF0` | `monsters-barbarous` | 12/19 | https://sw25.wikidot.com/monster:drake-baron-human-form |
| Drake Count (Dragon Form) | `hLZClwnQR3oxjtIL` | `monsters-barbarous` | 19/26 | https://sw25.wikidot.com/monster:drake-count-dragon-form |
| Hook Hoodling | `7cuv1CqnbHqaUFHl` | `monsters-barbarous` | 8/12 | https://sw25.wikidot.com/monster:hook-hoodling |
| Kobold Apprentice | `iTcmTCGwo4FNbtWo` | `monsters-barbarous` | 7/12 | https://sw25.wikidot.com/monster:kobold-apprentice |
| Kobold Marksman | `WH20ivRNEmV4OfeK` | `monsters-barbarous` | 7/13 | https://sw25.wikidot.com/monster:kobold-marksman |
| Minotaur | `rfkUvU4umMb282Qu` | `monsters-barbarous` | 10/17 | https://sw25.wikidot.com/monster:minotaur |
| Minotaur Caster | `I4jBSI1ukUpRThW3` | `monsters-barbarous` | 11/18 | https://sw25.wikidot.com/monster:minotaur-caster |
| Shield Hoodling | `SPVBo7WpS4ytehWl` | `monsters-barbarous` | 8/12 | https://sw25.wikidot.com/monster:shield-hoodling |
| Succubus | `KqeDmzESbRJoN1rC` | `monsters-barbarous` | 17/20 | https://sw25.wikidot.com/monster:succubus |
| Troll | `Cb2pecjUz8LLcYze` | `monsters-barbarous` | 11/16 | https://sw25.wikidot.com/monster:troll |
| Creeping Coin | `n4WfPLEfokjq9QQi` | `monsters-constructs` | 10/13 | https://sw25.wikidot.com/monster:creeping-coin |
| Heroic Avatar | `sTz2QOx0PhMKoFIA` | `monsters-constructs` | 19/22 | https://sw25.wikidot.com/monster:heroic-avatar |
| Sand Ghast | `uCDYWjHPMnjvo5EJ` | `monsters-constructs` | 9/11 | https://sw25.wikidot.com/monster:sand-ghast |
| Scarlet Stamp | `lr302YWE3txpYZL3` | `monsters-constructs` | 15/18 | https://sw25.wikidot.com/monster:scarlet-stamp |
| Unruly Sand Ghast | `YTBnGvskCZh2XcM8` | `monsters-constructs` | 14/16 | https://sw25.wikidot.com/monster:unruly-sand-ghast |
| Ezerve | `xrXNLTmpk6QGp6fv` | `monsters-daemons` | 18/22 | https://sw25.wikidot.com/monster:ezerve |
| Foregone | `muKvhvT51nJEKDhd` | `monsters-daemons` | 18/22 | https://sw25.wikidot.com/monster:foregone |
| Rigularador | `dJlixAOW3mVsk7BJ` | `monsters-daemons` | 13/16 | https://sw25.wikidot.com/monster:rigularador |
| Sallytegane | `V5JRgGT6Pqg32O0s` | `monsters-daemons` | 18/21 | https://sw25.wikidot.com/monster:sallytegane |
| Selassaroui | `iBcEbNPsGQHdeHbb` | `monsters-daemons` | 17/20 | https://sw25.wikidot.com/monster:selassaroui |
| Dimateravia | `ErGZInbCAw8i1QVe` | `monsters-magitech` | 18/21 | https://sw25.wikidot.com/monster:dimateravia |
| Maginohek | `3VlNzhE9fo3eegRV` | `monsters-magitech` | 18/21 | https://sw25.wikidot.com/monster:maginohek |
| Amphisbaena | `bM5anUNXNhNQ447a` | `monsters-mythical-beasts` | 12/18 | https://sw25.wikidot.com/monster:amphisbaena |
| Antar | `9JGreurd5Xb2AO6G` | `monsters-mythical-beasts` | 15/18 | https://sw25.wikidot.com/monster:antar |
| Chimera | `NmVfUkdPSTu0sZyt` | `monsters-mythical-beasts` | 13/20 | https://sw25.wikidot.com/monster:chimera |
| Chimera Summoner | `Ug65jgPOsvXlvc3Z` | `monsters-mythical-beasts` | 16/22 | https://sw25.wikidot.com/monster:chimera-summoner |
| Pondering Branch | `y3NUMKqBHymSPfke` | `monsters-plants` | 14/19 | https://sw25.wikidot.com/monster:pondering-branch |
| Death Sword | `uPPBaUKog34Ma4mm` | `monsters-undead` | 9/12 | https://sw25.wikidot.com/monster:death-sword |
| Ghost | `fyCiWFxmZnGbJlDa` | `monsters-undead` | 10/13 | https://sw25.wikidot.com/monster:ghost |
| Suicide Abyss Sword | `RbE39nvd4sOaDVIE` | `monsters-undead` | 12/14 | https://sw25.wikidot.com/monster:suicide-abyss-sword |

#### `Magic Damage +2` — 11 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Hammerhead | `XuYy4ooYcWa37vhH` | `monsters-animals` | 9/12 | https://sw25.wikidot.com/monster:hammerhead |
| Rushpecker | `LFKIHCkX2q8kIGuP` | `monsters-animals` | 9/12 | https://sw25.wikidot.com/monster:rushpecker |
| Daemonic Barbaroi: Minotaur Grunel | `YwSKKG5vl6P74jxo` | `monsters-barbarous` | 15/19 | https://sw25.wikidot.com/monster:daemonic-barbaroi |
| Goblin High King | `uFE5qZ6FPE1Ka4io` | `monsters-barbarous` | 12/17 | https://sw25.wikidot.com/monster:goblin-high-king |
| Goblin Lord | `HnxCCCrezKysNj99` | `monsters-barbarous` | 9/14 | https://sw25.wikidot.com/monster:goblin-lord |
| Zang | `Uy6Nqg4cwRzw3cvw` | `monsters-daemons` | 11/15 | https://sw25.wikidot.com/monster:zang |
| Ancient Ghost | `ig3XgTev485HRDY4` | `monsters-undead` | 16/22 | https://sw25.wikidot.com/monster:ancient-ghost |
| Iron Maiden | `N9eMNohvEr1VvQI5` | `monsters-undead` | 12/19 | https://sw25.wikidot.com/monster:iron-maiden |
| Poltergeist | `sSBcMJzvHHFUPFZB` | `monsters-undead` | 11/17 | https://sw25.wikidot.com/monster:poltergeist |
| Restirigist | `PrPqqHE4JxTPaVnc` | `monsters-undead` | 10/13 | https://sw25.wikidot.com/monster:restirigist |
| Suicide Sword | `hrBA8VeR7brUEjcc` | `monsters-undead` | 11/14 | https://sw25.wikidot.com/monster:suicide-sword |

#### `+2 Magic Damage` — 10 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Anaconda | `XwxfKJNAdYSHpMrY` | `monsters-animals` | 8/12 | https://sw25.wikidot.com/monster:anaconda |
| Vulture | `YHMus4j0FGTWvZfX` | `monsters-animals` | 9/13 | https://sw25.wikidot.com/monster:vulture |
| Blood Troll | `Lfe6HDvKNmlMq2gM` | `monsters-barbarous` | 17/20 | https://sw25.wikidot.com/monster:blood-troll |
| Drake Count (Human Form) | `3ASuDUap4GSs3BF5` | `monsters-barbarous` | 18/25 | https://sw25.wikidot.com/monster:drake-count-human-form |
| Goblin Shaman | `jFTNvNMKCs4DPjan` | `monsters-barbarous` | 13/16 | https://sw25.wikidot.com/monster:goblin-shaman |
| Hog Hoodling | `bz7dD1Afdvi91Ul3` | `monsters-barbarous` | 9/12 | https://sw25.wikidot.com/monster:hog-hoodling |
| Ogre Berserker | `kwOKk3sQkXeD1qIe` | `monsters-barbarous` | 15/19 | https://sw25.wikidot.com/monster:ogre-berserker |
| Junkwalker | `yh5wn3xe8iVlMzFS` | `monsters-constructs` | 13/16 | https://sw25.wikidot.com/monster:junkwalker |
| Shadow Teamster | `kst6tm8NdokSHOrj` | `monsters-constructs` | 13/16 | https://sw25.wikidot.com/monster:shadow-teamster |
| Miga | `i5KFwBKIQ9I1RCnt` | `monsters-magitech` | 13/16 | https://sw25.wikidot.com/monster:miga |

#### `Magic Damage +2 points` — 9 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Grey Lynx | `SG3HWfsWga7TtuOw` | `monsters-animals` | 12/15 | https://sw25.wikidot.com/monster:grey-lynx |
| Arrow Hoodling | `pb7Abd4u19YfpfmE` | `monsters-barbarous` | 6/11 | https://sw25.wikidot.com/monster:arrow-hoodling |
| Dagger Hoodling | `jmrlk0dYwA37aHmK` | `monsters-barbarous` | 6/11 | https://sw25.wikidot.com/monster:dagger-hoodling |
| Goblin | `QRrZZBNDs6m7sd2A` | `monsters-barbarous` | 5/10 | https://sw25.wikidot.com/monster:goblin |
| Kobold | `GmAPFM1aETtm6B35` | `monsters-barbarous` | 6/11 | https://sw25.wikidot.com/monster:kobold |
| Saber Hoodling | `5MNTImqPl73wfOyw` | `monsters-barbarous` | 7/11 | https://sw25.wikidot.com/monster:saber-hoodling |
| Nazrak | `NRtudAoteZgTcISw` | `monsters-daemons` | 13/16 | https://sw25.wikidot.com/monster:nazrak |
| Thunder Snowbird | `KcAHgkUimtP0CGCn` | `monsters-mythical-beasts` | 13/18 | https://sw25.wikidot.com/monster:thunder-snowbird |
| Thunderbird | `AVTHzMG26JrGDuK5` | `monsters-mythical-beasts` | 10/16 | https://sw25.wikidot.com/monster:thunderbird |

#### `Magic damage +2` — 2 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Grunel | `6uRPoBAU9iiOADfG` | `monsters-daemons` | 14/19 | https://sw25.wikidot.com/monster:grunel |
| Mud Mushroom | `S2rwMGfH7SpZ0DTe` | `monsters-plants` | 11/14 | https://sw25.wikidot.com/monster:mud-mushroom |

#### `+2 Magic damage` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Succubus Knight | `3N9uQTOjzEuvJULX` | `monsters-barbarous` | 22/26 | https://sw25.wikidot.com/monster:succubus-knight |

#### `Magic Damage +2 Points` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Erbirea | `7SZ0yAPQxDJRi1Xd` | `monsters-daemons` | 9/13 | https://sw25.wikidot.com/monster:erbirea |

### PRECISIÓN (69)

#### `Accuracy +1` — 69 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Cotton Crown | `op2R5vMOlR1QnOaq` | `monsters-animals` | 10/12 | https://sw25.wikidot.com/monster:cotton-crown |
| Filthy Rat | `OZTZdbX64I1MPWT8` | `monsters-animals` | 6/9 | https://sw25.wikidot.com/monster:filthy-rat |
| Giant Bat | `EtOVvi04PXKU6AeB` | `monsters-animals` | 8/12 | https://sw25.wikidot.com/monster:giant-bat |
| Kiparithos | `5icLLdbh7zv06WPW` | `monsters-animals` | 8/11 | https://sw25.wikidot.com/monster:kiparithos |
| Nest Guard Pamana Bee | `DhpA5tdCC59WJnge` | `monsters-animals` | 9/11 | https://sw25.wikidot.com/monster:nest-guard-pamana-bee |
| Roc | `nXvVPaAWZ5FDCHaL` | `monsters-animals` | 15/21 | https://sw25.wikidot.com/monster:roc |
| Sabertooth Tiger | `i1mpgkdmiL1vQJf0` | `monsters-animals` | 14/18 | https://sw25.wikidot.com/monster:sabertooth-tiger |
| Tiger | `slOKfaYPI4VNM63N` | `monsters-animals` | 10/14 | https://sw25.wikidot.com/monster:tiger |
| Alkaloid Arrow | `64BkzaqDwXP5N2np` | `monsters-barbarous` | 10/14 | https://sw25.wikidot.com/monster:alkaloid-arrow |
| Arakcruder | `RFHdtj0Yeo0rgKmj` | `monsters-barbarous` | 12/14 | https://sw25.wikidot.com/monster:arakcruder |
| Arakcruder Hunter | `540ZpoFlrc3vkE6g` | `monsters-barbarous` | 14/16 | https://sw25.wikidot.com/monster:arakcruder-hunter |
| Arakcruder Predator | `rUbrFg3I1xVwlg4U` | `monsters-barbarous` | 15/18 | https://sw25.wikidot.com/monster:arakcruder-predator |
| Dawn Ripper | `vGeDR4Jvn4gDACe2` | `monsters-barbarous` | 14/17 | https://sw25.wikidot.com/monster:dawn-ripper |
| Dawn Walker | `FG5TFzbB60gwGYWt` | `monsters-barbarous` | 12/15 | https://sw25.wikidot.com/monster:dawn-walker |
| Dowi Fomor | `SyBFBunIX5NH65ia` | `monsters-barbarous` | 16/20 | https://sw25.wikidot.com/monster:dowi-fomor |
| Fomor | `aCapgH72xcDCFHb8` | `monsters-barbarous` | 14/17 | https://sw25.wikidot.com/monster:fomor |
| Gian Fomor | `yBoFj8oG2tyfK2Bp` | `monsters-barbarous` | 19/23 | https://sw25.wikidot.com/monster:gian-fomor |
| Lesser Ogre | `9PVffIm6Q0S6BAMm` | `monsters-barbarous` | 9/14 | https://sw25.wikidot.com/monster:lesser-ogre |
| Manodanryu | `vensKsydtnpyOJTu` | `monsters-barbarous` | 15/18 | https://sw25.wikidot.com/monster:manodanryu |
| Manogaryu | `5pCTQ9pIXcl7N0pO` | `monsters-barbarous` | 8/13 | https://sw25.wikidot.com/monster:manogaryu |
| Manozalyu | `aIDgRvqHHl0HbLiI` | `monsters-barbarous` | 12/15 | https://sw25.wikidot.com/monster:manozalyu |
| Ogre | `qwawZarFoHwvNKpu` | `monsters-barbarous` | 12/15 | https://sw25.wikidot.com/monster:ogre |
| Ogre Wizard | `F7W2ktMsCRCKtnTC` | `monsters-barbarous` | 14/17 | https://sw25.wikidot.com/monster:ogre-wizard |
| Owlcrudel | `i4IpkqW8TQOWvGre` | `monsters-barbarous` | 14/16 | https://sw25.wikidot.com/monster:owlcrudel |
| Vampire Tetrahedron | `e8Ia61r0xDm8xNlr` | `monsters-barbarous` | 19/26 | https://sw25.wikidot.com/monster:vampire-tetrahedron |
| Abyss Servant | `zDLKnDKdqNwE5jyN` | `monsters-constructs` | 12/15 | https://sw25.wikidot.com/monster:abyss-servant |
| Carbide Claws | `clMwbslU7k6pwUXO` | `monsters-constructs` | 19/25 | https://sw25.wikidot.com/monster:carbide-claws |
| Chest Mimic | `84tfi03WGve9gYEQ` | `monsters-constructs` | 10/14 | https://sw25.wikidot.com/monster:chest-mimic |
| Deck Chest Trap | `006DBrvIMFuio3AR` | `monsters-constructs` | 9/13 | https://sw25.wikidot.com/monster:deck-chest-trap |
| Diadema | `IZ9b7mI1KL0d9Qvu` | `monsters-constructs` | 11/15 | https://sw25.wikidot.com/monster:diadema |
| Exceed Disaster | `KgyoX5YXCgBVHygZ` | `monsters-constructs` | 18/21 | https://sw25.wikidot.com/monster:exceed-disaster |
| Mithril Golem | `5NbQYOimgxdP1KIJ` | `monsters-constructs` | 19/25 | https://sw25.wikidot.com/monster:mithril-golem |
| Mono Pawn | `RMp69vvtVH4SuqFu` | `monsters-constructs` | 6/12 | https://sw25.wikidot.com/monster:mono-pawn |
| Abyss Minions | `6vphrbs2Gs3cI6pd` | `monsters-daemons` | 11/14 | https://sw25.wikidot.com/monster:abyss-minions |
| Agare | `mHbSXNFaEOlkNHLx` | `monsters-daemons` | 12/15 | https://sw25.wikidot.com/monster:agare |
| Barraganbuk | `WUZrG5MhOT5PnscW` | `monsters-daemons` | 14/18 | https://sw25.wikidot.com/monster:barraganbuk |
| Dikka | `X3VbLUi36romoI0H` | `monsters-daemons` | 10/14 | https://sw25.wikidot.com/monster:dikka |
| Gezed | `Q4twBgie2nu0SVO4` | `monsters-daemons` | 13/17 | https://sw25.wikidot.com/monster:gezed |
| Holgrad | `NoldVhToth4pvaCm` | `monsters-daemons` | 18/22 | https://sw25.wikidot.com/monster:holgrad |
| Lilim | `xDoWRIaLkRXaROs1` | `monsters-daemons` | 13/17 | https://sw25.wikidot.com/monster:lilim |
| Lunzemase | `lT4G46SXMFsPXro0` | `monsters-daemons` | 19/23 | https://sw25.wikidot.com/monster:lunzemase |
| Zalbard | `EYEz4UYQjUkGWGxX` | `monsters-daemons` | 13/18 | https://sw25.wikidot.com/monster:zalbard |
| Black Hound | `avFm0znlwhfGNC4u` | `monsters-fairies` | 14/17 | https://sw25.wikidot.com/monster:black-hound |
| Cait Sith | `0eZEHb2fe7MS7W58` | `monsters-fairies` | 9/16 | https://sw25.wikidot.com/monster:cait-sith |
| Caron | `BNfYk4qU5Wecz0RJ` | `monsters-fairies` | 14/19 | https://sw25.wikidot.com/monster:caron |
| Cu Sith | `JvY3O2zyHq81dkxH` | `monsters-fairies` | 11/20 | https://sw25.wikidot.com/monster:cu-sith |
| Direach | `9dyWjl9glTt9nD3h` | `monsters-fairies` | 17/20 | https://sw25.wikidot.com/monster:direach |
| Duergar | `fDxGGhJpZ1AzkD5z` | `monsters-fairies` | 16/19 | https://sw25.wikidot.com/monster:duergar |
| Fylgja | `a0aaIKEEMRnavL9i` | `monsters-fairies` | 13/19 | https://sw25.wikidot.com/monster:fylgja |
| Maeve | `SyeQsyQ46khDxnXe` | `monsters-fairies` | 20/23 | https://sw25.wikidot.com/monster:maeve |
| Menehune | `XJwazzirjK7CXx5u` | `monsters-fairies` | 12/15 | https://sw25.wikidot.com/monster:menehune |
| Nymph | `stUZSxWGvrA3BZfb` | `monsters-fairies` | 16/20 | https://sw25.wikidot.com/monster:nymph |
| Shade | `x0ZXl0n9oRelK3xU` | `monsters-fairies` | 11/15 | https://sw25.wikidot.com/monster:shade |
| Sprite | `LEZnmgIYMjPVB4uX` | `monsters-fairies` | 11/15 | https://sw25.wikidot.com/monster:sprite |
| Titania | `9IQouuO3QAKKHNPh` | `monsters-fairies` | 20/23 | https://sw25.wikidot.com/monster:titania |
| Will-o'-Wisp | `72KjVmf5vVdXzUYn` | `monsters-fairies` | 7/13 | https://sw25.wikidot.com/monster:will-o-wisp |
| Loam Puppet | `ZRtU8kTwO63AhsYL` | `monsters-golems` | 12/15 | https://sw25.wikidot.com/monster:loam-puppet |
| Platinum Dragon | `MMJNgC2UrjlgiThY` | `monsters-golems` | 17/23 | https://sw25.wikidot.com/monster:platinum-dragon |
| Rutile Raptor | `LDABEB5Ujb2rsW4h` | `monsters-golems` | 16/21 | https://sw25.wikidot.com/monster:rutile-raptor |
| Stone Servant | `8KOQS3F3HJ9P889G` | `monsters-golems` | 11/15 | https://sw25.wikidot.com/monster:stone-servant |
| Domsva | `tgUcV1wiMZSbxP5y` | `monsters-magitech` | 16/19 | https://sw25.wikidot.com/monster:domsva |
| Cocollona | `8znnlnaYuG43lJxU` | `monsters-mythical-beasts` | 16/22 | https://sw25.wikidot.com/monster:cocollona |
| Jii | `ruRx3upQ1zzqT70p` | `monsters-mythical-beasts` | 14/18 | https://sw25.wikidot.com/monster:jii |
| Pegasus | `Idd01UmBufsNtFIn` | `monsters-mythical-beasts` | 9/16 | https://sw25.wikidot.com/monster:pegasus |
| Unicorn | `t8nHLmRXz6j8q0pD` | `monsters-mythical-beasts` | 10/15 | https://sw25.wikidot.com/monster:unicorn |
| Wyvern | `xk7BgbkWVaVQ9Gp5` | `monsters-mythical-beasts` | 8/15 | https://sw25.wikidot.com/monster:wyvern |
| Meria Mistletoe | `9fo6ycuucvbEiomz` | `monsters-plants` | 13/16 | https://sw25.wikidot.com/monster:meria-mistletoe |
| Cursed Artist | `a6iuEGLMCCfb5HCW` | `monsters-undead` | 19/22 | https://sw25.wikidot.com/monster:cursed-artist |
| Ghoul Mage | `lsBc0vRQ2NcJUzZ9` | `monsters-undead` | 10/15 | https://sw25.wikidot.com/monster:ghoul-mage |

### FUEGO (117)

#### `Fire damage +3 points` — 57 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Ametrine Elk | `3eyLTyRa6ziMvl3t` | `monsters-animals` | 16/18 | https://sw25.wikidot.com/monster:ametrine-elk |
| Coast Lizard | `DgIs52wQhyMJsPmt` | `monsters-animals` | 13/16 | https://sw25.wikidot.com/monster:coast-lizard |
| Dolphin | `I53qiyd6z61hKY2B` | `monsters-animals` | 6/11 | https://sw25.wikidot.com/monster:dolphin |
| Grand Coast Lizard | `eJrYP2cZIMm7wREu` | `monsters-animals` | 16/19 | https://sw25.wikidot.com/monster:grand-coast-lizard |
| Mega Vice Beak | `dKjthV3AElZ1El8y` | `monsters-animals` | 15/17 | https://sw25.wikidot.com/monster:mega-vice-beak |
| Megaloceros | `ARPppPFd0EqRjxlJ` | `monsters-animals` | 19/22 | https://sw25.wikidot.com/monster:megaloceros |
| Spotted Bog Rhino | `LN3x1HbjzSfilelk` | `monsters-animals` | 18/21 | https://sw25.wikidot.com/monster:spotted-bog-rhino |
| Arbor Elder | `CSM0ina5WnyEgZep` | `monsters-barbarous` | 18/21 | https://sw25.wikidot.com/monster:arbor-elder |
| Cryoblaz | `8i5QmgiQoZ5QhUK2` | `monsters-barbarous` | 9/11 | https://sw25.wikidot.com/monster:cryoblaz |
| Cryodibraz | `hpj7fyQ4xutfIQBj` | `monsters-barbarous` | 11/13 | https://sw25.wikidot.com/monster:cryodibraz |
| Cryodicobraz | `3OdkxY83pcN0N4ff` | `monsters-barbarous` | 13/15 | https://sw25.wikidot.com/monster:cryodicobraz |
| Cryodilcobraz | `Z12h50IvsZHPnhaI` | `monsters-barbarous` | 14/17 | https://sw25.wikidot.com/monster:cryodilcobraz |
| Lake Giant | `xheKNsDJy7SKAPSY` | `monsters-barbarous` | 16/19 | https://sw25.wikidot.com/monster:lake-giant |
| Quepa | `xVM5Hb6ACmYhzlbK` | `monsters-barbarous` | 10/13 | https://sw25.wikidot.com/monster:quepa |
| Quepala | `khlq5lPPDZYZDUXa` | `monsters-barbarous` | 12/15 | https://sw25.wikidot.com/monster:quepala |
| Quepala'laga'ula | `kfcwOn7mSR2rna7G` | `monsters-barbarous` | 17/20 | https://sw25.wikidot.com/monster:quepalalagaula |
| Quepala'ula | `k4TGpaKDYKZCJ1XA` | `monsters-barbarous` | 13/16 | https://sw25.wikidot.com/monster:quepalaula |
| Zeanemo Rider | `YPziyzb0tkZeZXRP` | `monsters-barbarous` | 16/18 | https://sw25.wikidot.com/monster:zeanemo-rider |
| Blob | `MrkY838tVriFi5Wu` | `monsters-constructs` | 10/14 | https://sw25.wikidot.com/monster:blob |
| Disaster Tome | `dN2rAAlDyEGesFiE` | `monsters-constructs` | 18/21 | https://sw25.wikidot.com/monster:disaster-tome |
| Evil Index | `SzCDyxLgyOKUVvNr` | `monsters-constructs` | 15/18 | https://sw25.wikidot.com/monster:evil-index |
| Maid Blob | `twQfu2NlxDe1sf3l` | `monsters-constructs` | 14/17 | https://sw25.wikidot.com/monster:maid-blob |
| Thing | `RweRCEDK5XxTNChB` | `monsters-constructs` | 11/15 | https://sw25.wikidot.com/monster:thing |
| Barusa Biyone | `rzp92OeSjiSy9Yu2` | `monsters-daemons` | 19/23 | https://sw25.wikidot.com/monster:barusa-biyone |
| Dark Bully | `0A4zIeprB97DB8lh` | `monsters-daemons` | 15/18 | https://sw25.wikidot.com/monster:dark-bully |
| Hapsapra Rosil | `9N3utIIvD9f2RVeD` | `monsters-daemons` | 21/24 | https://sw25.wikidot.com/monster:hapsapra-rosil |
| Nuzumal | `Uwax6k8Z6G2c71m2` | `monsters-daemons` | 12/14 | https://sw25.wikidot.com/monster:nuzumal |
| Bannik | `9ArM5EZZ68ksOURT` | `monsters-fairies` | 10/14 | https://sw25.wikidot.com/monster:bannik |
| Cailleach | `yr4DSpK44Nf2tt20` | `monsters-fairies` | 18/21 | https://sw25.wikidot.com/monster:cailleach |
| Frau | `uyYwl43nlIStV9SJ` | `monsters-fairies` | 12/19 | https://sw25.wikidot.com/monster:frau |
| Mimir | `vZUQIg2x4igW1vP1` | `monsters-fairies` | 19/22 | https://sw25.wikidot.com/monster:mimir |
| Skyship | `jXIuSi9GCocu2BhI` | `monsters-magitech` | 16/19 | https://sw25.wikidot.com/monster:skyship |
| Abyss Toad | `GCOHuaTjsMDhhZSE` | `monsters-mythical-beasts` | 12/16 | https://sw25.wikidot.com/monster:abyss-toad |
| Airloo | `0Dx07D8GhmeMcoDt` | `monsters-mythical-beasts` | 8/13 | https://sw25.wikidot.com/monster:airloo |
| Amethyst Tapir | `NsnOg0WPQbP5JH14` | `monsters-mythical-beasts` | 15/18 | https://sw25.wikidot.com/monster:amethyst-tapir |
| Cuelebre | `eR2TlRVkH0wIVHJv` | `monsters-mythical-beasts` | 13/16 | https://sw25.wikidot.com/monster:cuelebre |
| Petsuchos | `r71wThv2VdpdCoU5` | `monsters-mythical-beasts` | 15/21 | https://sw25.wikidot.com/monster:petsuchos |
| Ypotryll | `uawFRBLYEbfCQqk6` | `monsters-mythical-beasts` | 15/18 | https://sw25.wikidot.com/monster:ypotryll |
| Abyss Tree | `1fdW3p5uu33ciIQf` | `monsters-plants` | 20/23 | https://sw25.wikidot.com/monster:abyss-tree |
| Belladonna | `Mp6agm5O9tYx1sKS` | `monsters-plants` | 16/20 | https://sw25.wikidot.com/monster:belladonna |
| Campanella Spruce | `7DNTrjTg8wTkp7sK` | `monsters-plants` | 13/17 | https://sw25.wikidot.com/monster:campanella-spruce |
| Coiled Ivy | `9GB5TTGIHF3XlCBJ` | `monsters-plants` | 11/14 | https://sw25.wikidot.com/monster:coiled-ivy |
| Daemonoid Ivy | `VcCTfW4ZGa2GNsCp` | `monsters-plants` | 17/19 | https://sw25.wikidot.com/monster:daemonoid-ivy |
| Daemonwood | `7u26TxqwmRvBS4Nz` | `monsters-plants` | 18/22 | https://sw25.wikidot.com/monster:daemonwood |
| Dancing Thorn | `pbyL8VH6xH03VxZ7` | `monsters-plants` | 10/12 | https://sw25.wikidot.com/monster:dancing-thorn |
| Dracaena Tree | `YguuCWllU9K5yUCA` | `monsters-plants` | 13/16 | https://sw25.wikidot.com/monster:dracaena-tree |
| Entlet | `hN5tmnayhEKP9uMm` | `monsters-plants` | 12/18 | https://sw25.wikidot.com/monster:entlet |
| Giant Fluffball | `BqkTNRsvM6xn6S2E` | `monsters-plants` | 14/17 | https://sw25.wikidot.com/monster:giant-fluffball |
| Grown Dracaena Tree | `2Ol1esKNQ21KO6Bw` | `monsters-plants` | 15/18 | https://sw25.wikidot.com/monster:grown-dracaena-tree |
| Moldsaurus | `FmcTQQqxuMNGFiEa` | `monsters-plants` | 16/21 | https://sw25.wikidot.com/monster:moldsaurus |
| Nest Acacia | `yuWWmtxlXOrt8vYY` | `monsters-plants` | 10/12 | https://sw25.wikidot.com/monster:nest-acacia |
| Spring Ivy | `FaHn4xPxh1Q3FrHA` | `monsters-plants` | 12/15 | https://sw25.wikidot.com/monster:spring-ivy |
| Tree Worm | `zrg1OjsgZ6eZYONg` | `monsters-plants` | 20/23 | https://sw25.wikidot.com/monster:tree-worm |
| Yggdrasil Sapling | `D4jk3bjA1jMfBI67` | `monsters-plants` | 18/23 | https://sw25.wikidot.com/monster:yggdrasil-sapling |
| Adapsia | `CJCW6Dr6DzqSoKKU` | `monsters-undead` | 12/15 | https://sw25.wikidot.com/monster:adapsia |
| Dryout Corpse | `UwZ6MD8ObNc5ivDQ` | `monsters-undead` | 15/17 | https://sw25.wikidot.com/monster:dryout-corpse |
| Weavewraith Warrior | `HLiUqIk97t13v1tq` | `monsters-undead` | 19/22 | https://sw25.wikidot.com/monster:weavewraith-warrior |

#### `Fire damage + 3 points` — 35 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Forest Kong | `hv2t0s2damOQT2Yy` | `monsters-animals` | 13/16 | https://sw25.wikidot.com/monster:forest-kong |
| Frost Panther | `yElPYp2V5re05QWH` | `monsters-animals` | 16/19 | https://sw25.wikidot.com/monster:frost-panther |
| Iron Turtle | `ivNQ7DjXRoTxX8XV` | `monsters-animals` | 12/17 | https://sw25.wikidot.com/monster:iron-turtle |
| Sea Serpent | `I8TlPFlYGPaiQJKg` | `monsters-animals` | 14/19 | https://sw25.wikidot.com/monster:sea-serpent |
| Arbor | `E8V8enBbQEREBhSR` | `monsters-barbarous` | 14/17 | https://sw25.wikidot.com/monster:arbor |
| Arbor Senior | `n41tEx4FNXmvDDla` | `monsters-barbarous` | 16/19 | https://sw25.wikidot.com/monster:arbor-senior |
| Grendel | `NOZvWSd7udObWZbP` | `monsters-barbarous` | 16/18 | https://sw25.wikidot.com/monster:grendel |
| Merman | `0917NCeHXe3XNozR` | `monsters-barbarous` | 11/14 | https://sw25.wikidot.com/monster:merman |
| Merman Bishop | `A26IR6jYrkaxJETh` | `monsters-barbarous` | 12/15 | https://sw25.wikidot.com/monster:merman-bishop |
| Quepala'marga'ula | `ike26HMB5ozUBDys` | `monsters-barbarous` | 19/22 | https://sw25.wikidot.com/monster:quepalamargaula |
| Quepala'ula'ula | `xPFyFASmliB3rqMX` | `monsters-barbarous` | 15/18 | https://sw25.wikidot.com/monster:quepalaulaula |
| Culvert Slime | `Mdg3dDSQKafpDizT` | `monsters-constructs` | 10/13 | https://sw25.wikidot.com/monster:culvert-slime |
| Ghost Curtain | `sFQ7S2tkQMCFHQGB` | `monsters-constructs` | 16/18 | https://sw25.wikidot.com/monster:ghost-curtain |
| Purple Blob | `gnqvko30LlHQzoW6` | `monsters-constructs` | 14/17 | https://sw25.wikidot.com/monster:purple-blob |
| Dreadbar | `cpiSL4GjRvGSZMcw` | `monsters-daemons` | 21/23 | https://sw25.wikidot.com/monster:dreadbar |
| Melbiz | `nVumVuWSsyKO4GMl` | `monsters-daemons` | 16/20 | https://sw25.wikidot.com/monster:melbiz |
| Sihalus | `BEJEEwFYop100Uik` | `monsters-daemons` | 15/18 | https://sw25.wikidot.com/monster:sihalus |
| Asrai | `cgvacyMvpjbhCqSO` | `monsters-fairies` | 20/23 | https://sw25.wikidot.com/monster:asrai |
| Dryad | `FV7aePB7F7wCUoQt` | `monsters-fairies` | 12/19 | https://sw25.wikidot.com/monster:dryad |
| Undine | `IPf3D1KkRZ1eabvF` | `monsters-fairies` | 11/16 | https://sw25.wikidot.com/monster:undine |
| Vila | `XNeypbtVRtdIBzHO` | `monsters-fairies` | 13/16 | https://sw25.wikidot.com/monster:vila |
| Brutal Varg | `GrBALdBT9x226LoX` | `monsters-mythical-beasts` | 13/18 | https://sw25.wikidot.com/monster:brutal-varg |
| Catoblepas | `wHBLy9wvfE9mvczd` | `monsters-mythical-beasts` | 17/20 | https://sw25.wikidot.com/monster:catoblepas |
| Great Varg | `fak1H6Ovjq7p9SBQ` | `monsters-mythical-beasts` | 15/21 | https://sw25.wikidot.com/monster:great-varg |
| Varg | `J4dgfV6FvGuvDfSi` | `monsters-mythical-beasts` | 11/16 | https://sw25.wikidot.com/monster:varg |
| Bloody Petal | `55BbgS4wLJg1LPrE` | `monsters-plants` | 11/14 | https://sw25.wikidot.com/monster:bloody-petal |
| Daemonwood Branch | `ZFBohJ5slbYyBMDC` | `monsters-plants` | 18/21 | https://sw25.wikidot.com/monster:daemonwood-branch |
| Fungal Parasite | `P1zugXJYhkZpYQSB` | `monsters-plants` | 19/22 | https://sw25.wikidot.com/monster:fungal-parasite |
| Green Cemetery | `1WQm8uzy17ctM5df` | `monsters-plants` | 18/21 | https://sw25.wikidot.com/monster:green-cemetery |
| Living Tree | `sHhLtJzIA9B5ipW2` | `monsters-plants` | 15/21 | https://sw25.wikidot.com/monster:living-tree |
| Blood Swamp | `yDB42fKhUSmJKC0h` | `monsters-undead` | 16/19 | https://sw25.wikidot.com/monster:blood-swamp |
| Dry Corpse | `5TIsecQTD4AeqOof` | `monsters-undead` | 8/13 | https://sw25.wikidot.com/monster:dry-corpse |
| Iceman | `gLUdgAmON1CVFVsT` | `monsters-undead` | 14/17 | https://sw25.wikidot.com/monster:iceman |
| Mummy | `AFgi81ha9CX37a9m` | `monsters-undead` | 15/18 | https://sw25.wikidot.com/monster:mummy |
| Mummy Lord | `wQuopoFdPvDm5HuB` | `monsters-undead` | 16/19 | https://sw25.wikidot.com/monster:mummy-lord |

#### `Fire Damage +3` — 13 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Giant Ice Crab | `0C7QgWySV8DwRVY0` | `monsters-animals` | 12/15 | https://sw25.wikidot.com/monster:giant-ice-crab |
| Spotted Rhino | `rjiDeWpbwHkXuzFQ` | `monsters-animals` | 13/16 | https://sw25.wikidot.com/monster:spotted-rhino |
| Warble Crow | `m91wATSb9P0JChjv` | `monsters-animals` | 11/14 | https://sw25.wikidot.com/monster:warble-crow |
| Cold Medusa | `D1MywFyg0CF5JF9l` | `monsters-barbarous` | 14/16 | https://sw25.wikidot.com/monster:cold-medusa |
| Gilman | `tB9LT9JJ08A6aZXE` | `monsters-barbarous` | 13/16 | https://sw25.wikidot.com/monster:gilman |
| Glass Basilisk (Human Form) | `QplvR1r0xQU19LDJ` | `monsters-barbarous` | 12/16 | https://sw25.wikidot.com/monster:glass-basilisk-human-form |
| Glass Basilisk (Monstrous Form) | `lOaoELaiDajclbZO` | `monsters-barbarous` | 12/16 | https://sw25.wikidot.com/monster:glass-basilisk-monstrous-form |
| Ghost Servant | `qxeJGy5bBYrMc2eT` | `monsters-constructs` | 17/19 | https://sw25.wikidot.com/monster:ghost-servant |
| Bugaradre | `rWlSKGOLTXhV8Lrn` | `monsters-daemons` | 16/20 | https://sw25.wikidot.com/monster:bugaradre |
| Beartrap Creeper | `g7rcV32T7NLBuPtr` | `monsters-plants` | 13/15 | https://sw25.wikidot.com/monster:beartrap-creeper |
| Giant Balloon Seed | `kxGb477WX0EV8fTu` | `monsters-plants` | 10/13 | https://sw25.wikidot.com/monster:giant-balloon-seed |
| Killer Cedar | `xNdmnEXlJUArv42a` | `monsters-plants` | 13/16 | https://sw25.wikidot.com/monster:killer-cedar |
| Marionette Ivy | `2aK80yzYp5HeWwAK` | `monsters-plants` | 15/18 | https://sw25.wikidot.com/monster:marionette-ivy |

#### `Fire damage +3` — 6 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Nailed Snail | `tB7uldpvKPvXRaTL` | `monsters-animals` | 12/14 | https://sw25.wikidot.com/monster:nailed-snail |
| Calcolu | `F5JcoSkzx06aC4yf` | `monsters-mythical-beasts` | 11/14 | https://sw25.wikidot.com/monster:calcolu |
| Big Archer | `ppYgS5LguklPPNSg` | `monsters-plants` | 10/15 | https://sw25.wikidot.com/monster:big-archer |
| Lake Balloon | `8JRGBsm2vRfddXLY` | `monsters-plants` | 11/14 | https://sw25.wikidot.com/monster:lake-balloon |
| Needle Archer | `Spn5goPNrEUFjFBq` | `monsters-plants` | 7/11 | https://sw25.wikidot.com/monster:needle-archer |
| Poison Pollen | `gdcPuCRiUCXKKfmb` | `monsters-plants` | 10/13 | https://sw25.wikidot.com/monster:poison-pollen |

#### `Fire Damage +3 points` — 4 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Yeti | `gikZdRwKjP2s8I5X` | `monsters-barbarous` | 14/17 | https://sw25.wikidot.com/monster:yeti |
| Oak Golem | `a3wlxHB25ui1fmiL` | `monsters-golems` | 8/12 | https://sw25.wikidot.com/monster:oak-golem |
| Oak Hound | `Hvg1LCaDulR63zGS` | `monsters-golems` | 8/12 | https://sw25.wikidot.com/monster:oak-hound |
| Straw Bird | `xBGR5Asd6U9VC5sP` | `monsters-golems` | 10/13 | https://sw25.wikidot.com/monster:straw-bird |

#### `Fire &amp; Earth damage + 3 points` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Skadi | `Df8GTgaWkcN6wDYn` | `monsters-fairies` | 18/21 | https://sw25.wikidot.com/monster:skadi |

#### `Fire damage +3 damage` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Green Torch | `0gUVJh8x12q9aLTU` | `monsters-plants` | 20/25 | https://sw25.wikidot.com/monster:green-torch |

### AGUA/HIELO (43)

#### `Water/Ice damage +3 points` — 23 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Gluttony Sandworm | `oz7Tru0FKXJmir96` | `monsters-animals` | 13/16 | https://sw25.wikidot.com/monster:gluttony-worm |
| Huge Saw Spider | `iYXtPGpdk15Mtm4U` | `monsters-animals` | 13/16 | https://sw25.wikidot.com/monster:huge-saw-spider |
| Rust Worm | `DsXsWESwZKhLbj8j` | `monsters-animals` | 14/19 | https://sw25.wikidot.com/monster:rust-worm |
| Fire Giant | `t1uqkyTE9SaRuaYQ` | `monsters-barbarous` | 17/21 | https://sw25.wikidot.com/monster:fire-giant |
| Formica Chief | `KuhZesnGcGcEynKQ` | `monsters-barbarous` | 14/17 | https://sw25.wikidot.com/monster:formica-chief |
| Formica Lord | `UZ91hpHda5IiQN0n` | `monsters-barbarous` | 17/20 | https://sw25.wikidot.com/monster:formica-lord |
| Formica Queen | `Ld5Vj8QTI1Hw1aRr` | `monsters-barbarous` | 15/18 | https://sw25.wikidot.com/monster:formica-queen |
| Formica Soldier | `oTtz9nxMHGm1LjAC` | `monsters-barbarous` | 12/15 | https://sw25.wikidot.com/monster:formica-soldier |
| Onyx Basilisk (Human Form) | `UERBqLM32tinCw9O` | `monsters-barbarous` | 11/19 | https://sw25.wikidot.com/monster:onyx-basilisk-human-form |
| Onyx Basilisk (Monstrous Form) | `ro9TO3ngwEd39CQT` | `monsters-barbarous` | 12/20 | https://sw25.wikidot.com/monster:onyx-basilisk-monstrous-form |
| Phosphor Sphere | `dcDPkhT0EQUnKcmM` | `monsters-constructs` | 15/20 | https://sw25.wikidot.com/monster:phosphor-sphere |
| Argagis | `rK3ojwyERwDrFiHW` | `monsters-daemons` | 13/16 | https://sw25.wikidot.com/monster:argagis |
| Efreet | `jjWIBNEQlaUJ9N1D` | `monsters-fairies` | 19/22 | https://sw25.wikidot.com/monster:efreet |
| Flamme | `QqHEJQRrPKdZ7gPN` | `monsters-fairies` | 11/14 | https://sw25.wikidot.com/monster:flamme |
| Lasebara | `mwt7zR4TIx83DKGY` | `monsters-fairies` | 16/19 | https://sw25.wikidot.com/monster:lasebara |
| Sparaci | `gWtSMZ69xSasvKfB` | `monsters-fairies` | 10/13 | https://sw25.wikidot.com/monster:sparaci |
| Vulkan | `L7M4ytQa2OITTZ5C` | `monsters-fairies` | 19/22 | https://sw25.wikidot.com/monster:vulkan |
| Cuir | `jI7suDSQtq5jD33I` | `monsters-magitech` | 10/13 | https://sw25.wikidot.com/monster:cuir |
| Bayard | `dWrqM254X9KwOppi` | `monsters-mythical-beasts` | 16/20 | https://sw25.wikidot.com/monster:bayard |
| Charm Bear | `yA3TtvHQro92Z6k3` | `monsters-mythical-beasts` | 13/16 | https://sw25.wikidot.com/monster:charm-bear |
| Grinning Cat | `ztpj8ix9f4mJN4LG` | `monsters-mythical-beasts` | 16/20 | https://sw25.wikidot.com/monster:grinning-cat |
| Abyss Dead Hound | `odBIMmu0MbLFhsYN` | `monsters-undead` | 15/18 | https://sw25.wikidot.com/monster:abyss-dead-hound |
| Warring Ash | `3X8vJXO6baO56EWU` | `monsters-undead` | 14/17 | https://sw25.wikidot.com/monster:warring-ash |

#### `Water/Ice damage + 3 points` — 14 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Blazing Mammoth | `5FNBXPKTZi7Y2EaZ` | `monsters-animals` | 22/25 | https://sw25.wikidot.com/monster:blazing-mammoth |
| Crimson Maggot | `xNCx18IIZqtzfMDb` | `monsters-animals` | 13/16 | https://sw25.wikidot.com/monster:crimson-maggot |
| Sandworm | `zXiwW7PD6AZvrJQN` | `monsters-animals` | 10/15 | https://sw25.wikidot.com/monster:sandworm |
| Basilisk (Human Form) | `MnONkbstCs4X6H0J` | `monsters-barbarous` | 13/16 | https://sw25.wikidot.com/monster:basilisk-human-form |
| Basilisk (Monstrous Form) | `Q3x4j25dz8p5zQF2` | `monsters-barbarous` | 11/16 | https://sw25.wikidot.com/monster:basilisk-monstrous-form |
| Ainsel | `VKteDz0Jmnk1xK0v` | `monsters-fairies` | 10/15 | https://sw25.wikidot.com/monster:ainsel |
| Domovoy | `jyWjamWuxBLwyCRd` | `monsters-fairies` | 13/19 | https://sw25.wikidot.com/monster:domovoy |
| Muspell | `8xA72H4I7dmd95yR` | `monsters-fairies` | 16/20 | https://sw25.wikidot.com/monster:muspell |
| Peri | `0HqtfDpdUfh9IKRJ` | `monsters-fairies` | 14/20 | https://sw25.wikidot.com/monster:peri |
| Salamander | `JvjjUUVlNnXJGL1o` | `monsters-fairies` | 11/16 | https://sw25.wikidot.com/monster:salamander |
| Cutting Torches | `dn5j2Dji4eobNBk3` | `monsters-magitech` | 10/13 | https://sw25.wikidot.com/monster:cutting-torches |
| Cockatrice | `zqpHNYXgW1j202je` | `monsters-mythical-beasts` | 15/20 | https://sw25.wikidot.com/monster:cockatrice |
| Hellhound | `0uB3yz5v4iyDyXDb` | `monsters-mythical-beasts` | 9/15 | https://sw25.wikidot.com/monster:hellhound |
| Ghost Horse | `YhBrX1Lorlmr9dr1` | `monsters-undead` | 15/22 | https://sw25.wikidot.com/monster:ghost-horse |

#### `Water/Ice Damage +3` — 4 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Talos Juggernaut | `lfLxdlJLrZpLPpVv` | `monsters-barbarous` | 17/20 | https://sw25.wikidot.com/monster:talos-juggernaut |
| Talos Warrior | `65jEAPSbc0CrurCj` | `monsters-barbarous` | 13/17 | https://sw25.wikidot.com/monster:talos-warrior |
| Jarega | `YZ6PxeL06UnX8Xlb` | `monsters-daemons` | 9/12 | https://sw25.wikidot.com/monster:jarega |
| Beep ARC | `dL6M85MtBCV05FaM` | `monsters-magitech` | 12/14 | https://sw25.wikidot.com/monster:beep-arc |

#### `Water/Ice +3 Damage` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Talos Soldier | `eCleeOFhYZAtKTZU` | `monsters-barbarous` | 12/15 | https://sw25.wikidot.com/monster:talos-soldier |

#### `Water/ice damage +3 points` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Marsavra | `LiS3gBTUqlYk1iW3` | `monsters-animals` | 17/20 | https://sw25.wikidot.com/monster:marsavra |

### CURACIÓN COMO DAÑO (43)

#### `HP Recovery (deals damage instead), +3 points` — 23 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Blood Sucker | `7RzwDgLDnaCbtdy6` | `monsters-undead` | 12/15 | https://sw25.wikidot.com/monster:blood-sucker |
| Bloodling | `Id7uYM9Br0sIJyxU` | `monsters-undead` | 10/14 | https://sw25.wikidot.com/monster:bloodling |
| Bone Knight | `BnkqQJUtyFRyckKu` | `monsters-undead` | 14/17 | https://sw25.wikidot.com/monster:bone-knight |
| Corpse Mass | `pgW8KltOWWpxcEAY` | `monsters-undead` | 13/16 | https://sw25.wikidot.com/monster:corpse-mass |
| Dark Hierophant | `UhpV5A8FKjlCifE9` | `monsters-undead` | 25/28 | https://sw25.wikidot.com/monster:dark-hierophant |
| Dragon Corpse | `CWC9IiPs9ktvyI5g` | `monsters-undead` | 16/19 | https://sw25.wikidot.com/monster:dragon-corpse |
| Flying Hands | `YFWuda2nFsYhqGok` | `monsters-undead` | 9/12 | https://sw25.wikidot.com/monster:flying-hands |
| Ghost Train | `Ju6RsvtKPtWttNEb` | `monsters-undead` | 14/17 | https://sw25.wikidot.com/monster:ghost-train |
| Ghoul | `fihA1xYifTVyq1or` | `monsters-undead` | 8/13 | https://sw25.wikidot.com/monster:ghoul |
| Gratuna's Whale Fall | `pyFl6qN2dsZDwJtg` | `monsters-undead` | 16/19 | https://sw25.wikidot.com/monster:gratunas-whale-fall |
| High Revenant | `sMRVWkBRF2bTRQ8A` | `monsters-undead` | 12/17 | https://sw25.wikidot.com/monster:high-revenant |
| Jack O'Lantern | `yo7SoAjvSeeubqX6` | `monsters-undead` | 13/17 | https://sw25.wikidot.com/monster:jack-olantern |
| Lanternhead | `Pipl8JGhUjsaWT1I` | `monsters-undead` | 12/15 | https://sw25.wikidot.com/monster:lanternhead |
| Mad Blood | `ZXSZfJZosW3B6hjv` | `monsters-undead` | 15/18 | https://sw25.wikidot.com/monster:mad-blood |
| Rotten Wanderer | `Tv6V7kYct0guQULa` | `monsters-undead` | 18/21 | https://sw25.wikidot.com/monster:rotten-wanderer |
| Rottenfolk | `B8NIbmGn6shF1ISY` | `monsters-undead` | 11/14 | https://sw25.wikidot.com/monster:rottenfolk |
| Skeleton Archer | `wisD0IJHZyFbmKsi` | `monsters-undead` | 6/13 | https://sw25.wikidot.com/monster:skeleton-archer |
| Skeleton Guardian | `t6cq9gF4fNXYTfaX` | `monsters-undead` | 13/16 | https://sw25.wikidot.com/monster:skeleton-guardian |
| Skeleton Heavy Archer | `30ZcV7C28OXxYGQI` | `monsters-undead` | 8/15 | https://sw25.wikidot.com/monster:skeleton-heavy-archer |
| Skeleton Soldier | `H2oaPrSc88L92Prp` | `monsters-undead` | 7/14 | https://sw25.wikidot.com/monster:skeleton-soldier |
| Skull Bird | `EtVYabsJorF1kRGW` | `monsters-undead` | 10/13 | https://sw25.wikidot.com/monster:skull-bird |
| Specter | `bE27h5pvQWWGmRWK` | `monsters-undead` | 14/17 | https://sw25.wikidot.com/monster:specter |
| Undead General | `8L0jxUFpvcQNyRw7` | `monsters-undead` | 16/20 | https://sw25.wikidot.com/monster:undead-general |

#### `HP Recovery (deals damage instead) +3 points` — 6 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Bone Hound | `mGd8juCvVV9yWMGi` | `monsters-undead` | 10/13 | https://sw25.wikidot.com/monster:bone-hound |
| Dullahan | `pvvRDJhQuxT2T489` | `monsters-undead` | 11/18 | https://sw25.wikidot.com/monster:dullahan |
| Phantom | `xc3ODe4EynlTGjsH` | `monsters-undead` | 10/16 | https://sw25.wikidot.com/monster:phantom |
| Revenant | `KAhk2ZIwdNxfMk2L` | `monsters-undead` | 8/14 | https://sw25.wikidot.com/monster:revenant |
| Skeleton | `O9HjRwYA910xxSd4` | `monsters-undead` | 6/11 | https://sw25.wikidot.com/monster:skeleton |
| Zombie | `2Af5RWZASOzT4cSq` | `monsters-undead` | 7/12 | https://sw25.wikidot.com/monster:zombie |

#### `HP Recovery (when deals damage) +3 points` — 3 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Frost Zombie | `sKFeqQNzLpKdVYPy` | `monsters-undead` | 8/13 | https://sw25.wikidot.com/monster:frost-zombie |
| Mice Ball | `7QrQCoWghmptru8p` | `monsters-undead` | 15/19 | https://sw25.wikidot.com/monster:mice-ball |
| Phantom Horse | `gyKrZ2SLIqMNITgZ` | `monsters-undead` | 12/17 | https://sw25.wikidot.com/monster:phantom-horse |

#### `HP Recovery Damage +3 points` — 3 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Abyss Corpse | `2DqgkQKwfKJaQey6` | `monsters-undead` | 11/15 | https://sw25.wikidot.com/monster:abyss-corpse |
| Abyss Marchers | `42oNpIQ418PGz86f` | `monsters-undead` | 17/23 | https://sw25.wikidot.com/monster:abyss-marchers |
| Abyss Regret | `WBUUWjOmPGUfRxC8` | `monsters-undead` | 10/13 | https://sw25.wikidot.com/monster:abyss-regret |

#### `HP Recovery (deals damage instead) +3` — 2 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Skeleton Fighter | `R3JLjfxz4J4wr7g0` | `monsters-undead` | 6/13 | https://sw25.wikidot.com/monster:skeleton-fighter |
| Zombie Dog | `W0DKMvZy5efIwxwI` | `monsters-undead` | 6/11 | https://sw25.wikidot.com/monster:zombie-dog |

#### `HP Recovery damage +3 points` — 2 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Ghoul Lynx | `xuTXFFPiHzBA2itT` | `monsters-undead` | 10/14 | https://sw25.wikidot.com/monster:ghoul-lynx |
| Lantern Bird | `FGwmJ9Bn4gygQDSQ` | `monsters-undead` | 12/14 | https://sw25.wikidot.com/monster:lantern-bird |

#### `HP Recovery (Deals damage instead) +3` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Plague Zombie | `QcljvAqamJWwu9Xc` | `monsters-undead` | 8/13 | https://sw25.wikidot.com/monster:plague-zombie |

#### `HP Recovery (deals damage instead), +3` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Vampire Hound | `46raO3CpM4Wu9hvX` | `monsters-undead` | 11/14 | https://sw25.wikidot.com/monster:vampire-hound |

#### `HP Recovery (deals damage instead), +4 points` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Dragon Zombie | `Z5B0h7IZoAhKdSCi` | `monsters-undead` | 20/27 | https://sw25.wikidot.com/monster:dragon-zombie |

#### `HP Recovery Damage (when deals damage), +3 points` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Abyss Skeleton Guard | `yhBFpQYl468sCdGM` | `monsters-undead` | 15/19 | https://sw25.wikidot.com/monster:abyss-skeleton-guard |

### CONTUNDENTE (36)

#### `Bludgeoning damage +3 points` — 15 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Fossil Chrysalis | `cPLI5miSTfWdYBQQ` | `monsters-animals` | 15/18 | https://sw25.wikidot.com/monster:fossil-chrysalis |
| Giant Crab | `tQevT5g8E27NWcTl` | `monsters-animals` | 11/14 | https://sw25.wikidot.com/monster:giant-crab |
| Swamp Worm | `P6OqUOcm5enxHB6E` | `monsters-animals` | 19/22 | https://sw25.wikidot.com/monster:swamp-worm |
| Corrupt Caterpillar | `x6h15xkob7Ddc3Gy` | `monsters-constructs` | 14/17 | https://sw25.wikidot.com/monster:corrupt-caterpillar |
| Magic Pot | `HfSEh9XLePRoGNqk` | `monsters-constructs` | 14/19 | https://sw25.wikidot.com/monster:magic-pot |
| Cerberus | `i8PVVkWIxYAiQZfB` | `monsters-daemons` | 15/20 | https://sw25.wikidot.com/monster:cerberus |
| Endertuz | `lTjqGz5Y10pcT0no` | `monsters-daemons` | 26/28 | https://sw25.wikidot.com/monster:endertuz |
| Geldam | `WuBPjKzJu26AYryP` | `monsters-daemons` | 22/27 | https://sw25.wikidot.com/monster:geldam |
| Bone Animal | `JvYdAKpu0fbiyK3B` | `monsters-golems` | 12/15 | https://sw25.wikidot.com/monster:bone-animal |
| Fixed Zerlay | `MTE553r0GbFgJPID` | `monsters-magitech` | 14/17 | https://sw25.wikidot.com/monster:fixed-zerlay |
| Gevaudan | `noJTo1ynuj2qlVXl` | `monsters-mythical-beasts` | 12/15 | https://sw25.wikidot.com/monster:gevaudan |
| Golden Ash | `AF9or36YycsujZkW` | `monsters-mythical-beasts` | 18/22 | https://sw25.wikidot.com/monster:golden-ash |
| Balloon Lotus | `mkuNiDGISi5SkfWZ` | `monsters-plants` | 11/14 | https://sw25.wikidot.com/monster:balloon-lotus |
| Rockwool Fluff | `kTQsrSjUnrvZL2AB` | `monsters-plants` | 8/12 | https://sw25.wikidot.com/monster:rockwool-fluff |
| Spinel Hood | `azaTGRUidH0Iyjpn` | `monsters-plants` | 13/17 | https://sw25.wikidot.com/monster:spinel-hood |

#### `Bludgeoning type damage +3 points` — 9 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Dinos | `xBVkBieG7VXs5HGH` | `monsters-animals` | 9/12 | https://sw25.wikidot.com/monster:dinos |
| Glasell | `WgmgLAzNzwvuYeTi` | `monsters-barbarous` | 13/17 | https://sw25.wikidot.com/monster:glasell |
| Glasell Violet | `aMB5rL9GDjrYK9Ag` | `monsters-barbarous` | 15/19 | https://sw25.wikidot.com/monster:glasell-violet |
| Familiar from Beyond | `Y0ozTVKfxxBtkcwK` | `monsters-constructs` | 12/14 | https://sw25.wikidot.com/monster:familiar-from-beyond |
| Insomnia Beat | `wFyspK3btR0JB0Bw` | `monsters-constructs` | 16/19 | https://sw25.wikidot.com/monster:insomnia-beat |
| Trap Mixer | `pe09vYJUWPL029DE` | `monsters-constructs` | 11/14 | https://sw25.wikidot.com/monster:trap-mixer |
| Gaspica | `sIacGocMw4ZxSbcr` | `monsters-magitech` | 15/17 | https://sw25.wikidot.com/monster:gaspica |
| SZerlay | `rX4zNPza51gKr3yG` | `monsters-magitech` | 12/15 | https://sw25.wikidot.com/monster:szerlay |
| Zerlay | `nEPwfE65WIxLpzoi` | `monsters-magitech` | 10/13 | https://sw25.wikidot.com/monster:zerlay |

#### `Bludgeoning Damage +3` — 4 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Sideby Cheetah | `unjhVEPGgIici5VL` | `monsters-animals` | 12/15 | https://sw25.wikidot.com/monster:sideby-cheetah |
| Quezardus | `0TQ4faX1nSz0Yboq` | `monsters-daemons` | 16/18 | https://sw25.wikidot.com/monster:quezardus |
| Bit | `VbcQNH3BYwVMdAa0` | `monsters-magitech` | 7/11 | https://sw25.wikidot.com/monster:bit |
| Medusa Head | `NQISS9v5tuxnK04J` | `monsters-plants` | 16/19 | https://sw25.wikidot.com/monster:medusa-head |

#### `Bludgeoning damage +3` — 3 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Red Helm | `NK06iD0PdzxDuiOT` | `monsters-animals` | 16/19 | https://sw25.wikidot.com/monster:red-helm |
| Garuda | `VuQGqhbwsLkGQPhf` | `monsters-barbarous` | 14/19 | https://sw25.wikidot.com/monster:garuda |
| Jinune | `OQk0ePcUNXksONni` | `monsters-daemons` | 14/17 | https://sw25.wikidot.com/monster:jinune |

#### `Bludgeoning type damage +3` — 2 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Gargoyle | `x3q2uuwvrMxPXIXH` | `monsters-constructs` | 9/14 | https://sw25.wikidot.com/monster:gargoyle |
| Rigogan | `jSldyLenhwqb4xFq` | `monsters-daemons` | 18/21 | https://sw25.wikidot.com/monster:rigogan |

#### `Bludgeoning Damage +3 points` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Brasswing | `mmY4iR1aUlaTXbA0` | `monsters-golems` | 11/15 | https://sw25.wikidot.com/monster:brasswing |

#### `Bludgeoning-type Damage +3` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Gattagoil | `Qz0kV83LbGhxu6H8` | `monsters-constructs` | 11/15 | https://sw25.wikidot.com/monster:gattagoil |

#### `Bludgeoning-type damage +3 points` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Paryoma | `y380qaP17gKwX02J` | `monsters-daemons` | 16/20 | https://sw25.wikidot.com/monster:paryoma |

### VIENTO (33)

#### `Wind type damage +3 points` — 14 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Giant Eagle | `LOn7nI49hjEOtUBP` | `monsters-animals` | 14/17 | https://sw25.wikidot.com/monster:giant-eagle |
| Gremlin | `iVySf299xM8MHgHd` | `monsters-barbarous` | 9/12 | https://sw25.wikidot.com/monster:gremlin |
| Hugl | `VwIEYyKgnT4EpCLW` | `monsters-barbarous` | 9/12 | https://sw25.wikidot.com/monster:hugl |
| Hugl Assaulter | `l56qpRbA3VftMqqO` | `monsters-barbarous` | 12/15 | https://sw25.wikidot.com/monster:hugl-assaulter |
| Hugl Caster | `Iu8kxOZxPaNVmA82` | `monsters-barbarous` | 10/13 | https://sw25.wikidot.com/monster:hugl-caster |
| Hugl Motor | `kyMpUDi8GGL2wGDC` | `monsters-barbarous` | 16/19 | https://sw25.wikidot.com/monster:hugl-motor |
| Perlas Cloud | `mzfeg4VZuwqCIoBM` | `monsters-constructs` | 15/18 | https://sw25.wikidot.com/monster:perlas-cloud |
| Cluricaun | `9K98yzzv3uXPKnKd` | `monsters-fairies` | 12/15 | https://sw25.wikidot.com/monster:cluricaun |
| Gnome | `flOOAL0kv2WExw98` | `monsters-fairies` | 11/16 | https://sw25.wikidot.com/monster:gnome |
| Knocker | `Cw4rG9vsDLQiK7g7` | `monsters-fairies` | 9/14 | https://sw25.wikidot.com/monster:knocker |
| Swarm of Muryans | `vBX73IVARE7Nhuso` | `monsters-fairies` | 8/14 | https://sw25.wikidot.com/monster:swarm-of-muryans |
| Zargand | `8Dx4qlYceZ3eNiNq` | `monsters-fairies` | 20/23 | https://sw25.wikidot.com/monster:zargand |
| Shuiri | `JBoQyxO4eJ6hGq1m` | `monsters-magitech` | 10/12 | https://sw25.wikidot.com/monster:shuiri |
| Griffon | `oxtsLNjXQ2M25QuM` | `monsters-mythical-beasts` | 12/18 | https://sw25.wikidot.com/monster:griffon |

#### `Wind damage +3 points` — 8 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Missile Dolphin | `E36B7tUwgO6jDMpS` | `monsters-animals` | 17/20 | https://sw25.wikidot.com/monster:missile-dolphin |
| Sky Whale | `ofMCIJ4mfwsNRnY5` | `monsters-animals` | 18/21 | https://sw25.wikidot.com/monster:sky-whale |
| Twin Head Falcon | `P8FBOiPoIsX170J1` | `monsters-animals` | 15/18 | https://sw25.wikidot.com/monster:twin-head-falcon |
| Titan | `o5otatySueTGHCgT` | `monsters-fairies` | 19/22 | https://sw25.wikidot.com/monster:titan |
| Elder Manticore | `ycWYAmy7LtG4pagj` | `monsters-mythical-beasts` | 17/22 | https://sw25.wikidot.com/monster:elder-manticore |
| Hermit Manticore | `KxA1H8iXxi0EEC51` | `monsters-mythical-beasts` | 13/18 | https://sw25.wikidot.com/monster:hermit-manticore |
| Kujata | `GsVOU5UnSoVNOnkx` | `monsters-mythical-beasts` | 18/24 | https://sw25.wikidot.com/monster:kujata |
| Lesser Manticore | `CKJva3uKN7rI7gqx` | `monsters-mythical-beasts` | 11/16 | https://sw25.wikidot.com/monster:lesser-manticore |

#### `Wind Damage +3` — 4 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Kidnapper Pelican | `z5zLwix7J3F79Ur0` | `monsters-animals` | 11/14 | https://sw25.wikidot.com/monster:kidnapper-pelican |
| Triblade Mantis | `HyVqYQt0M9D4QQLL` | `monsters-animals` | 16/19 | https://sw25.wikidot.com/monster:triblade-mantis |
| Winged Water Buffalo | `FGheIa6aXZffULDP` | `monsters-animals` | 14/17 | https://sw25.wikidot.com/monster:winged-water-buffalo |
| Gravity Root | `mFK67YVD9AYlQO2u` | `monsters-plants` | 17/20 | https://sw25.wikidot.com/monster:gravity-root |

#### `Wind-type damage +3 points` — 2 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Shushkar | `HClfYwrzffdg6IyL` | `monsters-magitech` | 14/16 | https://sw25.wikidot.com/monster:shushkar |
| Peryton | `Tgt0joW3JB81bu8Q` | `monsters-mythical-beasts` | 11/16 | https://sw25.wikidot.com/monster:peryton |

#### `Wind-type +3 damage` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Highland Hugl | `RynIbIyUE5hwleML` | `monsters-barbarous` | 13/16 | https://sw25.wikidot.com/monster:highland-hugl |

#### `Wind-type +3 Damage` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Ira Sabinga | `dKO0szUwFHlPpTtk` | `monsters-barbarous` | 13/15 | https://sw25.wikidot.com/monster:ira-sabinga |

#### `Wind-type Damage +3` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Sabinga | `FLmj4I0SJaJcJ7bb` | `monsters-barbarous` | 10/13 | https://sw25.wikidot.com/monster:sabinga |

#### `Wind-type damage +3` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Deep Gremlin | `VL03vSv7r6Rv4752` | `monsters-barbarous` | 8/13 | https://sw25.wikidot.com/monster:deep-gremlin |

#### `Wind-type Damage +3 points` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Black Griffon | `tb5264bdvAPjZ7x3` | `monsters-mythical-beasts` | 15/20 | https://sw25.wikidot.com/monster:black-griffon |

### CORTANTE (28)

#### `Slashing damage +3 points` — 9 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Shark | `FmHllzkhBErCT4d2` | `monsters-animals` | 9/12 | https://sw25.wikidot.com/monster:shark |
| Tusk Crazy | `75XJ5y0VWMc2yeHk` | `monsters-barbarous` | 16/19 | https://sw25.wikidot.com/monster:tusk-crazy |
| Tusk Force | `GMsReq1eZwEn2xBT` | `monsters-barbarous` | 14/17 | https://sw25.wikidot.com/monster:tusk-force |
| Tusk Hammer | `5npb5rr1R7YFIlw9` | `monsters-barbarous` | 12/15 | https://sw25.wikidot.com/monster:tusk-hammer |
| Doppelganger | `ngKldYRtwoQaHxHQ` | `monsters-daemons` | 19/23 | https://sw25.wikidot.com/monster:doppelganger |
| Lada Adroda | `rjkzOq2NDEVngjFr` | `monsters-daemons` | 19/24 | https://sw25.wikidot.com/monster:lada-adroda |
| Vangiga | `NwQkxLFFk5kMWZX7` | `monsters-daemons` | 18/22 | https://sw25.wikidot.com/monster:vangiga |
| Tilgris | `TduoUBngQLEM07pW` | `monsters-mythical-beasts` | 14/17 | https://sw25.wikidot.com/monster:tilgris |
| Hundred Bouquet | `k0443XNqVzPVEZ7y` | `monsters-plants` | 11/13 | https://sw25.wikidot.com/monster:hundred-bouquet |

#### `Slashing type damage +3 points` — 8 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Volticfist | `YdvX59TF9G2GWmri` | `monsters-barbarous` | 15/18 | https://sw25.wikidot.com/monster:volticfist |
| Casting Hand | `oV6SsGrm7ZEw4Dxi` | `monsters-constructs` | 13/17 | https://sw25.wikidot.com/monster:casting-hand |
| Core Imitator | `9H264ewk2OlafxcR` | `monsters-constructs` | 10/13 | https://sw25.wikidot.com/monster:core-imitator |
| Flying Hoop | `57cvNQizVUp0A5rE` | `monsters-constructs` | 11/14 | https://sw25.wikidot.com/monster:flying-hoop |
| Terror Familiar | `yfLFbzFmV1hMdgaD` | `monsters-constructs` | 14/17 | https://sw25.wikidot.com/monster:terror-familiar |
| Gershuls | `DKfz19FyLceiUfCJ` | `monsters-magitech` | 18/21 | https://sw25.wikidot.com/monster:gershuls |
| Tentacle Kelp | `p1AxStUqbo0z7tUU` | `monsters-plants` | 14/17 | https://sw25.wikidot.com/monster:tentacle-kelp |
| Veil of Darkness | `LearNcKMJm3IoFaB` | `monsters-undead` | 16/20 | https://sw25.wikidot.com/monster:veil-of-darkness |

#### `Slashing type damage +3` — 5 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Rumblefist | `IKO3hxwds0clpFUo` | `monsters-barbarous` | 13/16 | https://sw25.wikidot.com/monster:rumblefist |
| Kekkubak | `q0MksJDa7fV3jxx0` | `monsters-daemons` | 12/15 | https://sw25.wikidot.com/monster:kekkubak |
| Xenu | `cTNVji0LGZn8JqCw` | `monsters-daemons` | 14/18 | https://sw25.wikidot.com/monster:xenu |
| Gradient Plum | `UYfX4kQASCmNmrtG` | `monsters-plants` | 13/16 | https://sw25.wikidot.com/monster:gradient-plum |
| Rotten Beast | `qBk0vFJu6E34C2QS` | `monsters-undead` | 18/21 | https://sw25.wikidot.com/monster:rotten-beast |

#### `Slashing damage +3` — 3 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Imp | `R2XmSNsQQ7fs4vpk` | `monsters-daemons` | 12/15 | https://sw25.wikidot.com/monster:imp |
| Mahatiga | `fHGIl658fYDnql09` | `monsters-daemons` | 18/22 | https://sw25.wikidot.com/monster:mahatiga |
| Ragnakang | `h65s6xpNsQn3F9SF` | `monsters-daemons` | 16/19 | https://sw25.wikidot.com/monster:ragnakang |

#### `Slashing-type Damage +3` — 2 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Macabrefist | `BcskVtinY3FjrSsj` | `monsters-barbarous` | 15/17 | https://sw25.wikidot.com/monster:macabrefist |
| Caltrop Carpet | `WzVRQVOBfIqcMTMe` | `monsters-constructs` | 10/14 | https://sw25.wikidot.com/monster:caltrop-carpet |

#### `Slashing-type damage +3 points` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Sevaseva | `Hro7TznYNat7Hlfd` | `monsters-daemons` | 15/19 | https://sw25.wikidot.com/monster:sevaseva |

### RAYO (27)

#### `Lightning damage +3 points` — 17 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Swordmaton | `qB1DjdH0xi2ueunD` | `monsters-constructs` | 12/15 | https://sw25.wikidot.com/monster:swordmaton |
| Barba Kagner | `HbwOza0Hyya0FgAG` | `monsters-magitech` | 16/19 | https://sw25.wikidot.com/monster:barba-kagner |
| Barren Dorn | `08Ub5ON3KRAgnBbD` | `monsters-magitech` | 13/16 | https://sw25.wikidot.com/monster:barren-dorn |
| Burrdorn | `bAIeoULK00BdM1A3` | `monsters-magitech` | 11/14 | https://sw25.wikidot.com/monster:burrdorn |
| Cure Kagner | `livFBngr3LfWeBre` | `monsters-magitech` | 13/15 | https://sw25.wikidot.com/monster:cure-kagner |
| Dorn | `zrUvbRurMtL9smHV` | `monsters-magitech` | 9/12 | https://sw25.wikidot.com/monster:dorn |
| Galil | `yJbsZMPHWEdal5s8` | `monsters-magitech` | 10/13 | https://sw25.wikidot.com/monster:galil |
| Gardes Dorn | `H3dseu5iig7EL9s8` | `monsters-magitech` | 16/19 | https://sw25.wikidot.com/monster:gardes-dorn |
| Gavan DOOM | `T6d1jv9pcLYm7e0c` | `monsters-magitech` | 15/18 | https://sw25.wikidot.com/monster:gavan-doom |
| Gichas | `7b9i3jOftKNE4EgZ` | `monsters-magitech` | 12/14 | https://sw25.wikidot.com/monster:gichas |
| Kagner | `U2GAu6EF9JHUluK4` | `monsters-magitech` | 10/13 | https://sw25.wikidot.com/monster:kagner |
| Lang Kagner | `ddy7APyhE9OQ3pvM` | `monsters-magitech` | 14/17 | https://sw25.wikidot.com/monster:lang-kagner |
| Material Dealer | `OGZYt8RTXeDL7F2r` | `monsters-magitech` | 19/22 | https://sw25.wikidot.com/monster:material-dealer |
| Rail Eater | `pfZMHM2dJsELa96t` | `monsters-magitech` | 15/18 | https://sw25.wikidot.com/monster:rail-eater |
| Rock Pestle | `lqaVjW1oGl4kfc06` | `monsters-magitech` | 18/21 | https://sw25.wikidot.com/monster:rock-pestle |
| Star Sniper | `lNRg6lbJEeySv59s` | `monsters-magitech` | 15/18 | https://sw25.wikidot.com/monster:star-sniper |
| Zerlay Dorn | `pZBscNs20lB2lbWR` | `monsters-magitech` | 17/20 | https://sw25.wikidot.com/monster:zerlay-dorn |

#### `Lightning damage + 3 points` — 6 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Deg Kagner | `CgbRMEoRMUz56MHD` | `monsters-magitech` | 12/15 | https://sw25.wikidot.com/monster:deg-kagner |
| Dragon Fortress | `G5brOT1pIwSCogqM` | `monsters-magitech` | 17/20 | https://sw25.wikidot.com/monster:dragon-fortress |
| Hibrayzan | `axLMquBYLOgImGNK` | `monsters-magitech` | 14/17 | https://sw25.wikidot.com/monster:hibrayzan |
| Redorn | `HpW9kwWoqs8Wd5g7` | `monsters-magitech` | 10/13 | https://sw25.wikidot.com/monster:redorn |
| Kamawet | `tF2hqddhEmJPPevD` | `monsters-mythical-beasts` | 5/12 | https://sw25.wikidot.com/monster:kamawet |
| Steam Pod | `EdP2C8dKYHeuGq6d` | `monsters-plants` | 7/11 | https://sw25.wikidot.com/monster:steam-pod |

#### `Lightning damage + 3` — 2 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Fake Angler | `nYilCby0lJIx1POV` | `monsters-animals` | 16/19 | https://sw25.wikidot.com/monster:fake-angler |
| Scorpo | `iP9XZz7qEJDbu4jB` | `monsters-magitech` | 13/16 | https://sw25.wikidot.com/monster:scorpo |

#### `Lightning Damage +3` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Renguard | `F4M7d0iqqak7neHd` | `monsters-magitech` | 7/12 | https://sw25.wikidot.com/monster:renguard |

#### `Lightning damage +3 damage` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Magireplica | `YG6n8LhktnB0v6Gk` | `monsters-magitech` | 0/0 | https://sw25.wikidot.com/monster:magireplica |

### TIERRA (26)

#### `Earth damage + 3 points` — 16 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Culvert Worm | `sEgjEUuErNYzjU0r` | `monsters-animals` | 11/16 | https://sw25.wikidot.com/monster:culvert-worm |
| Noisy Rattlesnake | `xxxrAlovo9yHOd7f` | `monsters-animals` | 17/20 | https://sw25.wikidot.com/monster:noisy-rattlesnake |
| Centaur | `D0XXBGDAL4NYW8Dh` | `monsters-barbarous` | 10/13 | https://sw25.wikidot.com/monster:centaur |
| Centaur Impaler | `IwCwCsLdOmEwzI3c` | `monsters-barbarous` | 11/17 | https://sw25.wikidot.com/monster:centaur-impaler |
| Lizardman | `U91XmRqzxgZrz03D` | `monsters-barbarous` | 11/14 | https://sw25.wikidot.com/monster:lizardman |
| Lizardman Bearer | `hJlVi5qDwDDXX6jU` | `monsters-barbarous` | 12/15 | https://sw25.wikidot.com/monster:lizardman-bearer |
| Lizardman Mariner | `WTtJDXfgq7hj9MBQ` | `monsters-barbarous` | 12/16 | https://sw25.wikidot.com/monster:lizardman-mariner |
| Sahagin | `ceCQFmWZMvRWB2bT` | `monsters-barbarous` | 10/13 | https://sw25.wikidot.com/monster:sahagin |
| Echo | `tofrOc7roEUJiyqm` | `monsters-fairies` | 11/15 | https://sw25.wikidot.com/monster:echo |
| Jinn | `dllB9ohsBA2AV7V6` | `monsters-fairies` | 19/22 | https://sw25.wikidot.com/monster:jinn |
| Puck | `vmf0iW3v40i3fRgd` | `monsters-fairies` | 12/19 | https://sw25.wikidot.com/monster:puck |
| Silky | `vwPbavEtABbMh0Kl` | `monsters-fairies` | 10/13 | https://sw25.wikidot.com/monster:silky |
| Sylph | `u90XvZ1QuV29truy` | `monsters-fairies` | 11/16 | https://sw25.wikidot.com/monster:sylph |
| Emerald Raccoon | `ls4V8oY53WurKurw` | `monsters-mythical-beasts` | 12/15 | https://sw25.wikidot.com/monster:emerald-raccoon |
| Gurangatch | `i0CMs9bwczXM2pFu` | `monsters-mythical-beasts` | 18/21 | https://sw25.wikidot.com/monster:gurangatch |
| Lemming | `KAyDG2oP7eZWtLgk` | `monsters-mythical-beasts` | 10/13 | https://sw25.wikidot.com/monster:lemming |

#### `Earth damage +3 points` — 6 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Centaur Penetrator | `Pns0OCSR3NWM140O` | `monsters-barbarous` | 12/18 | https://sw25.wikidot.com/monster:centaur-penetrator |
| Deep Sahagin | `hDQ3sE6AteMRcg7P` | `monsters-barbarous` | 15/18 | https://sw25.wikidot.com/monster:deep-sahagin |
| Deep Sahagin Priest | `zaAzyFn0FMH3EJd6` | `monsters-barbarous` | 17/20 | https://sw25.wikidot.com/monster:deep-sahagin-priest |
| Pixie | `HWrszaL3JwpIyRXU` | `monsters-fairies` | 9/14 | https://sw25.wikidot.com/monster:pixie |
| Sleipnir | `cZHtLOj4TgZY8TwY` | `monsters-fairies` | 18/21 | https://sw25.wikidot.com/monster:sleipnir |
| Sky Wyvern | `KFLCqLVJ9PPKQeDq` | `monsters-mythical-beasts` | 12/17 | https://sw25.wikidot.com/monster:sky-wyvern |

#### `Earth Damage +3` — 3 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Poison Toad | `5gsAqb9EXn0Yj9ZY` | `monsters-animals` | 9/12 | https://sw25.wikidot.com/monster:poison-toad |
| Centaur Heavy Knight | `t70PqsgISbXsOXZy` | `monsters-barbarous` | 13/19 | https://sw25.wikidot.com/monster:centaur-heavy-knight |
| Jahgrad | `P8nnPuMD4zmk2gSW` | `monsters-daemons` | 19/22 | https://sw25.wikidot.com/monster:jahgrad |

#### `Earth Damage + 3 points` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Blade Storm | `AKUQC6lkbBokcT3U` | `monsters-animals` | 17/20 | https://sw25.wikidot.com/monster:blade-storm |

### ENERGÍA (23)

#### `Energy damage +3 points` — 12 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Lunoicos | `nj5IeGFlj7nuBSxP` | `monsters-animals` | 17/21 | https://sw25.wikidot.com/monster:lunoicos |
| Diablo Captain (Daemon Form) | `7HPp3tcjRFczQTkU` | `monsters-barbarous` | 24/27 | https://sw25.wikidot.com/monster:diablo-captain-daemon-form |
| Diablo Captain (Human Form) | `x0k4CpRBbwp8jt1f` | `monsters-barbarous` | 23/26 | https://sw25.wikidot.com/monster:diablo-captain-human-form |
| Diablo Lieutenant (Human Form) | `KEgfESJRTXBHV1ZV` | `monsters-barbarous` | 18/21 | https://sw25.wikidot.com/monster:diablo-lieutenant-human-form |
| Rainbow Rainmaker | `2l0u2ESUBaeTo98b` | `monsters-constructs` | 16/19 | https://sw25.wikidot.com/monster:rainbow-rainmaker |
| Terror Beast | `0vej1dELyD0LytDj` | `monsters-daemons` | 14/18 | https://sw25.wikidot.com/monster:terror-beast |
| Bronze Golem | `J9o0CN0B5PZU92XE` | `monsters-golems` | 14/20 | https://sw25.wikidot.com/monster:bronze-golem |
| Granite Shell | `meneypJgWRddEqSl` | `monsters-golems` | 17/22 | https://sw25.wikidot.com/monster:granite-shell |
| Iron Golem | `fjiwfIA3inu35jpB` | `monsters-golems` | 16/22 | https://sw25.wikidot.com/monster:iron-golem |
| Rock Golem | `rwRzOX9oIpyz33e1` | `monsters-golems` | 13/18 | https://sw25.wikidot.com/monster:rock-golem |
| Banshee | `FypyYfomCHiRqQto` | `monsters-undead` | 12/19 | https://sw25.wikidot.com/monster:banshee |
| Dullahan Lord | `prKtd4PPRJvur5jr` | `monsters-undead` | 17/24 | https://sw25.wikidot.com/monster:dullahan-lord |

#### `Energy type damage +3 points` — 4 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Diablo Cadet (Daemon Form) | `SQXMIjNsZfmFYK00` | `monsters-barbarous` | 14/17 | https://sw25.wikidot.com/monster:diablo-cadet-daemon-form |
| Diablo Cadet (Human Form) | `A2GVHnStTSBkwLlS` | `monsters-barbarous` | 13/16 | https://sw25.wikidot.com/monster:diablo-cadet-human-form |
| Abyss Golem | `zRfr4EACRsu9uBjf` | `monsters-constructs` | 14/18 | https://sw25.wikidot.com/monster:abyss-golem |
| Cherub | `3Ik1tGeDylZXyRuu` | `monsters-mythical-beasts` | 12/15 | https://sw25.wikidot.com/monster:cherub |

#### `+3 Energy damage` — 2 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Lizard Fly | `lzw9aSCZkwasxFS2` | `monsters-animals` | 9/13 | https://sw25.wikidot.com/monster:lizard-fly |
| Poisonous Spillbug | `lG9HA78HHifAgBV3` | `monsters-animals` | 10/13 | https://sw25.wikidot.com/monster:poisonous-spillbug |

#### `Energy damage +3` — 2 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Diablo Lieutenant (Daemon Form) | `tCZeAG8zhyOoL4Oe` | `monsters-barbarous` | 19/22 | https://sw25.wikidot.com/monster:diablo-lieutenant-daemon-form |
| Shabalay | `4rfftjXaPWvbI2dg` | `monsters-daemons` | 16/19 | https://sw25.wikidot.com/monster:shabalay |

#### `Energy type damage +3` — 2 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Cheap Stone | `cl0RHDGOIYFeYTzt` | `monsters-constructs` | 7/10 | https://sw25.wikidot.com/monster:cheap-stone |
| Lethe | `Zia2OKYsqOe6fiS6` | `monsters-fairies` | 20/23 | https://sw25.wikidot.com/monster:lethe |

#### `Energy Damage +3 points` — 1 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Shadow of the Shard | `oxGQdgN1InbJy9Ua` | `monsters-undead` | 10/13 | https://sw25.wikidot.com/monster:shadow-of-the-shard |

### PLATA (11)

#### `Silver Weapon Damage +3` — 6 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Immature Vampire | `4ViLoQrI5BO8v8Ec` | `monsters-barbarous` | 12/17 | https://sw25.wikidot.com/monster:immature-vampire |
| Grudge Wight | `qjnEIWQsyU99A7Ic` | `monsters-undead` | 13/15 | https://sw25.wikidot.com/monster:grudge-wight |
| Implicit Grudge Wight | `zyf0Fx2Yigv4clBO` | `monsters-undead` | 17/20 | https://sw25.wikidot.com/monster:implicit-grudge-wight |
| Night Ghoul | `FzOhNO5j7gyoDN6D` | `monsters-undead` | 14/15 | https://sw25.wikidot.com/monster:night-ghoul |
| Poisonous Wight | `khTf0naUcXBqqxCj` | `monsters-undead` | 15/20 | https://sw25.wikidot.com/monster:poisonous-wight |
| Wight | `SoEUsJiGWeOYkOOo` | `monsters-undead` | 11/14 | https://sw25.wikidot.com/monster:wight |

#### `Silver weapon damage +3 points` — 5 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Lesser Vampire | `VqCiMQYCVeU2dVDv` | `monsters-barbarous` | 12/20 | https://sw25.wikidot.com/monster:lesser-vampire |
| Werewolf | `JX8gsCCxduchYm0o` | `monsters-barbarous` | 11/16 | https://sw25.wikidot.com/monster:werewolf |
| Jabberwock | `MF26Z0m7gIXHKcuY` | `monsters-mythical-beasts` | 19/22 | https://sw25.wikidot.com/monster:jabberwock |
| Dedarium | `D5CLoQ5iIKSWcVQm` | `monsters-undead` | 13/15 | https://sw25.wikidot.com/monster:dedarium |
| Redish Dedarium | `G7hbHorR4xJL9LPQ` | `monsters-undead` | 14/16 | https://sw25.wikidot.com/monster:redish-dedarium |

### NONE (48)

#### `None` — 48 monstruo(s)

| Nombre | ID | Pack | Rep/Weak | URL |
|--------|----|------|----------|-----|
| Familiars I | `XHxmZ1PG7kWfckzr` | `monsters-constructs` | 8/0 | https://sw25.wikidot.com/monster:familiars-i |
| Familiars II | `xVZUvG4mm1xWUu6V` | `monsters-constructs` | 12/0 | https://sw25.wikidot.com/monster:familiars-ii |
| Abyss Crosser | `4oEInGcup73TdKwS` | `monsters-humanoids` | 13/0 | https://sw25.wikidot.com/monster:abyss-crosser |
| Abyss Gazer Betrayer | `08CsJdwcKlGpwQvj` | `monsters-humanoids` | 10/0 | https://sw25.wikidot.com/monster:abyss-gazer-betrayer |
| Abyss Glimpser | `FMA5DPmGrbyH1BDS` | `monsters-humanoids` | 4/0 | https://sw25.wikidot.com/monster:abyss-glimpser |
| Abyss-Entranced Gazer | `42Xm9bUOENAQ8MZd` | `monsters-humanoids` | 9/0 | https://sw25.wikidot.com/monster:abyss-entranced-gazer |
| Alchemist Scholar | `8QfwxpYgshHhdzQ5` | `monsters-humanoids` | 11/0 | https://sw25.wikidot.com/monster:alchemist-scholar |
| Apprentice Assassin | `k2GVOoU8kHVIYqMb` | `monsters-humanoids` | 6/0 | https://sw25.wikidot.com/monster:apprentice-assassin |
| Armed Merchant | `fPMToZY3QWpRvEjU` | `monsters-humanoids` | 4/0 | https://sw25.wikidot.com/monster:armed-merchant |
| Artificer Sniper | `RW8zFvdqDizWTZYO` | `monsters-humanoids` | 15/0 | https://sw25.wikidot.com/monster:artificer-sniper |
| Bandit Archer | `8Nf64gfY7g5RhNSX` | `monsters-humanoids` | 5/0 | https://sw25.wikidot.com/monster:bandit-archer |
| Bandit Leader | `S5fg8v0lOQOmdsPx` | `monsters-humanoids` | 7/0 | https://sw25.wikidot.com/monster:bandit-leader |
| Bandit Trooper | `bAp44uzCHRehmbtt` | `monsters-humanoids` | 5/0 | https://sw25.wikidot.com/monster:bandit-trooper |
| Battle-Hardened Strategist | `Jx47JhQ25R5ojB7x` | `monsters-humanoids` | 12/0 | https://sw25.wikidot.com/monster:battle-hardened-strategist |
| Biker Robber | `R3hO5NxF3JEzYT71` | `monsters-humanoids` | 7/0 | https://sw25.wikidot.com/monster:biker-robber |
| Black-Clad Archer | `ZzzPkIBypjJ8vUAt` | `monsters-humanoids` | 6/0 | https://sw25.wikidot.com/monster:black-clad-archer |
| Dedicated Wizard | `I18RjvO5OnvdjqXi` | `monsters-humanoids` | 8/0 | https://sw25.wikidot.com/monster:dedicated-wizard |
| Dual-Wielding Battle Dancer | `kow5tDpmefxz4rdj` | `monsters-humanoids` | 10/0 | https://sw25.wikidot.com/monster:dual-wielding-battle-dancer |
| Emerging Sniper | `10ZAro7w95JrPOv0` | `monsters-humanoids` | 8/0 | https://sw25.wikidot.com/monster:emerging-sniper |
| Energetic Battle Dancer | `abR0oeuUbq99Wjmn` | `monsters-humanoids` | 8/0 | https://sw25.wikidot.com/monster:energetic-battle-dancer |
| Evil Bishop | `jpWpSchgobGIFdRp` | `monsters-humanoids` | 16/0 | https://sw25.wikidot.com/monster:evil-bishop |
| Evil God's Apostle | `JQfUnTQ59mUqqv9r` | `monsters-humanoids` | 11/0 | https://sw25.wikidot.com/monster:evil-gods-apostle |
| Evil Knight | `lVndbseNDBlrC1k3` | `monsters-humanoids` | 8/0 | https://sw25.wikidot.com/monster:evil-knight |
| Evil Priest | `jFub3gGrTcJgkg83` | `monsters-humanoids` | 10/0 | https://sw25.wikidot.com/monster:evil-priest |
| Fairy Swordsman Expert | `VAe3aA6n8THora1v` | `monsters-humanoids` | 12/0 | https://sw25.wikidot.com/monster:fairy-swordsman-expert |
| Fallen Wizard | `1t9DJngIoWCQXaFr` | `monsters-humanoids` | 6/0 | https://sw25.wikidot.com/monster:fallen-wizard |
| Heavy Shielded Guard | `DtQhRg0P9hWEBL9e` | `monsters-humanoids` | 14/0 | https://sw25.wikidot.com/monster:heavy-shielded-guard |
| Heretic Priest | `o5M4DR1Cay4s4Yps` | `monsters-humanoids` | 13/0 | https://sw25.wikidot.com/monster:heretic-priest |
| Lone Kick Master | `EeIXINTfhd7YKiZd` | `monsters-humanoids` | 12/0 | https://sw25.wikidot.com/monster:lone-kick-master |
| Longbowman | `6YQzeZBqlNzspWT4` | `monsters-humanoids` | 8/0 | https://sw25.wikidot.com/monster:longbowman |
| Magic Student | `rgW22T4kGJf3RVR7` | `monsters-humanoids` | 5/0 | https://sw25.wikidot.com/monster:magic-student |
| Mounted Bandit | `IafK80Vpa3sXJmvy` | `monsters-humanoids` | 6/0 | https://sw25.wikidot.com/monster:mounted-bandit |
| Novice Dark Hunter | `XcwElBhPW2DcyvJZ` | `monsters-humanoids` | 5/0 | https://sw25.wikidot.com/monster:novice-dark-hunter |
| Ordinary Person | `6oML1f3KvdkMYIYL` | `monsters-humanoids` | 3/0 | https://sw25.wikidot.com/monster:ordinary-person |
| Promising Magic Warrior | `FipwQzelhiZI2lRk` | `monsters-humanoids` | 7/0 | https://sw25.wikidot.com/monster:promising-magic-warrior |
| Promising Magician | `wOC7QqHZhVdhSkg2` | `monsters-humanoids` | 7/0 | https://sw25.wikidot.com/monster:promising-magician |
| Runaway Carriage Robbers | `DvWtzLaOWFKTL1Gp` | `monsters-humanoids` | 11/0 | https://sw25.wikidot.com/monster:runaway-carriage-robbers |
| Scarred | `ysnekPMOXsykfZCM` | `monsters-humanoids` | 7/0 | https://sw25.wikidot.com/monster:scarred |
| Skald | `1FNn6elO6qlHkyVL` | `monsters-humanoids` | 9/0 | https://sw25.wikidot.com/monster:skald |
| Skilled Assassin | `wRG4NldgHcAVyE30` | `monsters-humanoids` | 9/0 | https://sw25.wikidot.com/monster:skilled-assassin |
| Skilled Dark Hunter | `ev62lwl7gs5LBdMp` | `monsters-humanoids` | 11/0 | https://sw25.wikidot.com/monster:skilled-dark-hunter |
| Skilled Mercenary | `SL07Bw6atgvzd7Xs` | `monsters-humanoids` | 8/0 | https://sw25.wikidot.com/monster:skilled-mercenary |
| Sorcerer | `xdpk7Mucl8PFnXaR` | `monsters-humanoids` | 9/0 | https://sw25.wikidot.com/monster:sorcerer |
| Strong Heavy Warrior | `AlqTmIZE4iSM7WfA` | `monsters-humanoids` | 9/0 | https://sw25.wikidot.com/monster:strong-heavy-warrior |
| Support-Specialized Magic Archer | `TBAtLpTuslKXxlgC` | `monsters-humanoids` | 6/0 | https://sw25.wikidot.com/monster:support-specialized-magic-archer |
| Swift Blade | `up4jOLzzFB41Dybh` | `monsters-humanoids` | 6/0 | https://sw25.wikidot.com/monster:swift-blade |
| Thoughtful Forest Master | `OSgNE9o4w4JOpZFh` | `monsters-humanoids` | 11/0 | https://sw25.wikidot.com/monster:thoughtful-forest-master |
| Vengeance-Obsessed Dark Hunter | `oXQdDaM54It1B2AU` | `monsters-humanoids` | 10/0 | https://sw25.wikidot.com/monster:vengeance-obsessed-dark-hunter |


---

## 5. Análisis de los 49 registros con `weakness = 0`

### 5.1 Mecanismo del parser

`module/importer/monster-parser.mjs`:

```javascript
// línea 23
const numeric = value => Number(String(value ?? "").match(/-?\d+/)?.[0] ?? 0);
// líneas 150-151
const reputationWeakness = field("Reputation\\s*\\/\\s*Weakness");
const [reputation = "0", weakness = "0"] = reputationWeakness.split("/").map(value => value.trim());
// línea 408
reputation: numeric(reputation), weakness: numeric(weakness), weakPoint: field("Weak Point"),
```

Consecuencias:

- `"16/13"` → rep 16, weak 13 (caso normal).
- `"16/-"` → weak `numeric("-")` → `0` (la regex no encuentra número) → **no es un fallo del parser**: el `-` del RAW significa "sin debilidad".
- `"3"` (solo rep) → el elemento débil no existe y aplica el default → weak 0.
- `"※/※"` → `numeric("※")` → 0 (marcador de plantilla).
- Si el wiki entero omite el bloque → rep 0 y weak 0.

### 5.2 Subcasos identificados

| Subcaso | Descripción | Verificado (wiki) | Cantidad |
|---------|-------------|-------------------|----------|
| **Subcaso A** | Wiki muestra solo la reputación (sin umbral): contenido proveniente de fuentes 2.0 sin renovar o páginas simplificadas | ✅ Ordinary Person (`Rep/Weak: 3`, contenido SW2.0) | 1 verificada; resto de los 47 con `None`: pendiente de verificación individual |
| **Subcaso B** | Wiki muestra `X/-` en formato impreso (`"Rep/Weak: X/-"`) + `Weak Point: None` | ✅ Evil Bishop (`16/-`), Familiars I (`8/-`, contenido CR I p. 434, `Weak Point: None`) | 2 verificadas; Familiars II probadamente del mismo formato, pendiente |
| **Subcaso C** | Wiki muestra `※/※` (marcador de plantilla): monstruo "By Model" cuyo bloque es variable por modelo; la debilidad se define por plantilla (CR III p. 383, `Lightning damage +3 damage`), no por instancia | ✅ Magireplica | 1 |

**Conclusión:** El valor `0` **no es un error de importación** en ninguno de los subcasos verificados: es la traducción directa de "sin debilidad" (`-`) o de una entrada omitida/placeholder (`※`). Bajo RAW, `SV ≥ 0` tecnicamente seguiría cumpliéndose con éxito automático, pero con `weakPoint = "None"` no hay efecto que aplicar. Para **Magireplica** los datos deben tomarse de la plantilla (CR III p. 383), no del `0`.

### 5.3 Tabla completa de los 49 registros

| Nombre | ID | Pack | Rep/Weak | WeakPoint almacenado | URL | Verificación |
|--------|----|------|----------|----------------------|-----|--------------|
| Familiars I | `XHxmZ1PG7kWfckzr` | `monsters-constructs` | 8/0 | `None` | https://sw25.wikidot.com/monster:familiars-i | ✅ B (`8/-`, CR I p. 434, `Weak Point: None`) |
| Familiars II | `xVZUvG4mm1xWUu6V` | `monsters-constructs` | 12/0 | `None` | https://sw25.wikidot.com/monster:familiars-ii | ✅ B (pendiente; mismo formato que Familiars I) |
| Abyss Crosser | `4oEInGcup73TdKwS` | `monsters-humanoids` | 13/0 | `None` | https://sw25.wikidot.com/monster:abyss-crosser | — (pendiente de verificación wiki) |
| Abyss Gazer Betrayer | `08CsJdwcKlGpwQvj` | `monsters-humanoids` | 10/0 | `None` | https://sw25.wikidot.com/monster:abyss-gazer-betrayer | — (pendiente de verificación wiki) |
| Abyss Glimpser | `FMA5DPmGrbyH1BDS` | `monsters-humanoids` | 4/0 | `None` | https://sw25.wikidot.com/monster:abyss-glimpser | — (pendiente de verificación wiki) |
| Abyss-Entranced Gazer | `42Xm9bUOENAQ8MZd` | `monsters-humanoids` | 9/0 | `None` | https://sw25.wikidot.com/monster:abyss-entranced-gazer | — (pendiente de verificación wiki) |
| Alchemist Scholar | `8QfwxpYgshHhdzQ5` | `monsters-humanoids` | 11/0 | `None` | https://sw25.wikidot.com/monster:alchemist-scholar | — (pendiente de verificación wiki) |
| Apprentice Assassin | `k2GVOoU8kHVIYqMb` | `monsters-humanoids` | 6/0 | `None` | https://sw25.wikidot.com/monster:apprentice-assassin | — (pendiente de verificación wiki) |
| Armed Merchant | `fPMToZY3QWpRvEjU` | `monsters-humanoids` | 4/0 | `None` | https://sw25.wikidot.com/monster:armed-merchant | — (pendiente de verificación wiki) |
| Artificer Sniper | `RW8zFvdqDizWTZYO` | `monsters-humanoids` | 15/0 | `None` | https://sw25.wikidot.com/monster:artificer-sniper | — (pendiente de verificación wiki) |
| Bandit Archer | `8Nf64gfY7g5RhNSX` | `monsters-humanoids` | 5/0 | `None` | https://sw25.wikidot.com/monster:bandit-archer | — (pendiente de verificación wiki) |
| Bandit Leader | `S5fg8v0lOQOmdsPx` | `monsters-humanoids` | 7/0 | `None` | https://sw25.wikidot.com/monster:bandit-leader | — (pendiente de verificación wiki) |
| Bandit Trooper | `bAp44uzCHRehmbtt` | `monsters-humanoids` | 5/0 | `None` | https://sw25.wikidot.com/monster:bandit-trooper | — (pendiente de verificación wiki) |
| Battle-Hardened Strategist | `Jx47JhQ25R5ojB7x` | `monsters-humanoids` | 12/0 | `None` | https://sw25.wikidot.com/monster:battle-hardened-strategist | — (pendiente de verificación wiki) |
| Biker Robber | `R3hO5NxF3JEzYT71` | `monsters-humanoids` | 7/0 | `None` | https://sw25.wikidot.com/monster:biker-robber | — (pendiente de verificación wiki) |
| Black-Clad Archer | `ZzzPkIBypjJ8vUAt` | `monsters-humanoids` | 6/0 | `None` | https://sw25.wikidot.com/monster:black-clad-archer | — (pendiente de verificación wiki) |
| Dedicated Wizard | `I18RjvO5OnvdjqXi` | `monsters-humanoids` | 8/0 | `None` | https://sw25.wikidot.com/monster:dedicated-wizard | — (pendiente de verificación wiki) |
| Dual-Wielding Battle Dancer | `kow5tDpmefxz4rdj` | `monsters-humanoids` | 10/0 | `None` | https://sw25.wikidot.com/monster:dual-wielding-battle-dancer | — (pendiente de verificación wiki) |
| Emerging Sniper | `10ZAro7w95JrPOv0` | `monsters-humanoids` | 8/0 | `None` | https://sw25.wikidot.com/monster:emerging-sniper | — (pendiente de verificación wiki) |
| Energetic Battle Dancer | `abR0oeuUbq99Wjmn` | `monsters-humanoids` | 8/0 | `None` | https://sw25.wikidot.com/monster:energetic-battle-dancer | — (pendiente de verificación wiki) |
| Evil Bishop | `jpWpSchgobGIFdRp` | `monsters-humanoids` | 16/0 | `None` | https://sw25.wikidot.com/monster:evil-bishop | ✅ B (`16/-` formato impreso) |
| Evil God's Apostle | `JQfUnTQ59mUqqv9r` | `monsters-humanoids` | 11/0 | `None` | https://sw25.wikidot.com/monster:evil-gods-apostle | — (pendiente de verificación wiki) |
| Evil Knight | `lVndbseNDBlrC1k3` | `monsters-humanoids` | 8/0 | `None` | https://sw25.wikidot.com/monster:evil-knight | — (pendiente de verificación wiki) |
| Evil Priest | `jFub3gGrTcJgkg83` | `monsters-humanoids` | 10/0 | `None` | https://sw25.wikidot.com/monster:evil-priest | — (pendiente de verificación wiki) |
| Fairy Swordsman Expert | `VAe3aA6n8THora1v` | `monsters-humanoids` | 12/0 | `None` | https://sw25.wikidot.com/monster:fairy-swordsman-expert | — (pendiente de verificación wiki) |
| Fallen Wizard | `1t9DJngIoWCQXaFr` | `monsters-humanoids` | 6/0 | `None` | https://sw25.wikidot.com/monster:fallen-wizard | — (pendiente de verificación wiki) |
| Heavy Shielded Guard | `DtQhRg0P9hWEBL9e` | `monsters-humanoids` | 14/0 | `None` | https://sw25.wikidot.com/monster:heavy-shielded-guard | — (pendiente de verificación wiki) |
| Heretic Priest | `o5M4DR1Cay4s4Yps` | `monsters-humanoids` | 13/0 | `None` | https://sw25.wikidot.com/monster:heretic-priest | — (pendiente de verificación wiki) |
| Lone Kick Master | `EeIXINTfhd7YKiZd` | `monsters-humanoids` | 12/0 | `None` | https://sw25.wikidot.com/monster:lone-kick-master | — (pendiente de verificación wiki) |
| Longbowman | `6YQzeZBqlNzspWT4` | `monsters-humanoids` | 8/0 | `None` | https://sw25.wikidot.com/monster:longbowman | — (pendiente de verificación wiki) |
| Magic Student | `rgW22T4kGJf3RVR7` | `monsters-humanoids` | 5/0 | `None` | https://sw25.wikidot.com/monster:magic-student | — (pendiente de verificación wiki) |
| Mounted Bandit | `IafK80Vpa3sXJmvy` | `monsters-humanoids` | 6/0 | `None` | https://sw25.wikidot.com/monster:mounted-bandit | — (pendiente de verificación wiki) |
| Novice Dark Hunter | `XcwElBhPW2DcyvJZ` | `monsters-humanoids` | 5/0 | `None` | https://sw25.wikidot.com/monster:novice-dark-hunter | — (pendiente de verificación wiki) |
| Ordinary Person | `6oML1f3KvdkMYIYL` | `monsters-humanoids` | 3/0 | `None` | https://sw25.wikidot.com/monster:ordinary-person | ✅ A (contenido SW2.0, `Rep/Weak: 3`) |
| Promising Magic Warrior | `FipwQzelhiZI2lRk` | `monsters-humanoids` | 7/0 | `None` | https://sw25.wikidot.com/monster:promising-magic-warrior | — (pendiente de verificación wiki) |
| Promising Magician | `wOC7QqHZhVdhSkg2` | `monsters-humanoids` | 7/0 | `None` | https://sw25.wikidot.com/monster:promising-magician | — (pendiente de verificación wiki) |
| Runaway Carriage Robbers | `DvWtzLaOWFKTL1Gp` | `monsters-humanoids` | 11/0 | `None` | https://sw25.wikidot.com/monster:runaway-carriage-robbers | — (pendiente de verificación wiki) |
| Scarred | `ysnekPMOXsykfZCM` | `monsters-humanoids` | 7/0 | `None` | https://sw25.wikidot.com/monster:scarred | — (pendiente de verificación wiki) |
| Skald | `1FNn6elO6qlHkyVL` | `monsters-humanoids` | 9/0 | `None` | https://sw25.wikidot.com/monster:skald | — (pendiente de verificación wiki) |
| Skilled Assassin | `wRG4NldgHcAVyE30` | `monsters-humanoids` | 9/0 | `None` | https://sw25.wikidot.com/monster:skilled-assassin | — (pendiente de verificación wiki) |
| Skilled Dark Hunter | `ev62lwl7gs5LBdMp` | `monsters-humanoids` | 11/0 | `None` | https://sw25.wikidot.com/monster:skilled-dark-hunter | — (pendiente de verificación wiki) |
| Skilled Mercenary | `SL07Bw6atgvzd7Xs` | `monsters-humanoids` | 8/0 | `None` | https://sw25.wikidot.com/monster:skilled-mercenary | — (pendiente de verificación wiki) |
| Sorcerer | `xdpk7Mucl8PFnXaR` | `monsters-humanoids` | 9/0 | `None` | https://sw25.wikidot.com/monster:sorcerer | — (pendiente de verificación wiki) |
| Strong Heavy Warrior | `AlqTmIZE4iSM7WfA` | `monsters-humanoids` | 9/0 | `None` | https://sw25.wikidot.com/monster:strong-heavy-warrior | — (pendiente de verificación wiki) |
| Support-Specialized Magic Archer | `TBAtLpTuslKXxlgC` | `monsters-humanoids` | 6/0 | `None` | https://sw25.wikidot.com/monster:support-specialized-magic-archer | — (pendiente de verificación wiki) |
| Swift Blade | `up4jOLzzFB41Dybh` | `monsters-humanoids` | 6/0 | `None` | https://sw25.wikidot.com/monster:swift-blade | — (pendiente de verificación wiki) |
| Thoughtful Forest Master | `OSgNE9o4w4JOpZFh` | `monsters-humanoids` | 11/0 | `None` | https://sw25.wikidot.com/monster:thoughtful-forest-master | — (pendiente de verificación wiki) |
| Vengeance-Obsessed Dark Hunter | `oXQdDaM54It1B2AU` | `monsters-humanoids` | 10/0 | `None` | https://sw25.wikidot.com/monster:vengeance-obsessed-dark-hunter | — (pendiente de verificación wiki) |
| Magireplica | `YG6n8LhktnB0v6Gk` | `monsters-magitech` | 0/0 | `Lightning damage +3 damage` | https://sw25.wikidot.com/monster:magireplica | ✅ C (`※/※`, plantilla CR III p. 383 `Lightning damage +3 damage`) |

---

## 6. Reglas RAW (Sword World 2.5)

Todas las citas siguientes fueron verificadas sobre los PDF de `D:\Foundry Assets\Sword-World-Sources\` (número de página impresa del manual).

### 6.1 Físico vs mágico y orden de cálculo de daño — CR I, pp. 134–136 («Damage»)

- **CR I p. 134 — «Confirm Whether Physical or Magical Damage»:**
  > "Physical damage is caused by mechanical effects such as weapon blows or collisions with walls or the ground, while magical damage is caused by special effects such as fire, cold air, or electric shocks. […] physical damage is reduced by the Defense granted by armor and other protective gear, while magical damage is not reduced by Defense."

- **CR I pp. 135–136 — Efectos que aumentan el daño (Total Damage).** Dentro de esta fase se enumeran las debilidades de monstruos:
  > "Monster's weaknesses such as 'Fire Damage +3 points,' 'Physical Damage +2 points,' etc." (CR I, p. 136)

- **CR I p. 136 — «Apply Effects that Reduce Damage (Applied Damage)»:**
  > "Once you have finished applying damage increasing effects, then apply damage decreasing effects. […] The Defense of armor and shields reduce only physical damage. If the Applied Damage is negative, it is treated as '0' instead."

**Consecuencia RAW:** las debilidades se suman **antes** de la Defense → `applied = max(0, raw + bonus − defense)` y nunca negativo. Ejemplo Wolfe/goblin (CR I pp. 136–138): Total Damage → mantener olas; luego restar Defense; Applied ≥ 0.

### 6.2 Conocimiento de monstruos y puntos débiles — CR I, pp. 382–383

- **CR I p. 382 — «Monster Knowledge check»:**
  > "If a Monster Knowledge Check is successful, the PC's player may read the data for the relevant monster, even if the GM has created a so-called original monster that is not in the rulebook."

- **CR I p. 383 — «Monster's Weak Points»:**
  > "When a character who has acquired the Sage class makes a Monster Knowledge Check, if the success value is equal to or greater than the Weakness Value in the monster data, Weak Point can be applied to the monster by the entire party. Although double 6s seem to treat the detection of this Weak Point as an automatic success, it is, in fact, not possible for a character not possessing the Sage class to know Weak Points."

- **CR I p. 383 — «GM Guide: After a Successful Monster Knowledge Check» (duración):**
  > "Discovered Weak Points are valid for one session only. The result of the first Monster Knowledge Check made can be applied until the end of the session. The Weak Point must be detected again in another session."

### 6.3 Duración en Ancient Blue — Ancient Blue, p. 21 («Duration of Monster Knowledge Check (Weak Points)»)

> "When a PC with the Sage class performs a Monster Knowledge check and obtains a Success Value equal to or greater than the monster's weakness, it remains effective for 'one session' only (see CR I, p. 382). In this book, each time PCs return to [Base], it is treated as the end of 'one session,' and the application period of weak points obtained through Monster Knowledge checks follows this rule."

### 6.4 Dark Hunter (solo Daemons) — Abyss Breaker, p. 28

> "Monster Knowledge check (Limited to Daemons) [Intelligence] — Automatically determines whether the encountered monster is classified as a Daemon. A Monster Knowledge check can be performed if it is classified as Daemon. If the Success Value is equal to or greater than Daemon's weakness, the weak point will also be applied."

### 6.5 Extensiones del Dark Hunter — ◯Monster Watch, Abyss Breaker, p. 31

> "The Monster Knowledge check performed by the Dark Hunter class will be expanded from 'Daemon-only' to include 'Daemons, Barbarous, and Undead.' … When a user's Dark Hunter class level reaches 5 or higher, in this Monster Knowledge check, if the target has the 'Classification: Daemon', the weakness is treated as -4 points lower than usual. However, it will not decrease below reputation at minimum. … If a user's Dark Hunter class level is 10 or higher, and if the Success Value of the Monster Knowledge check against a monster of the relevant classification is equal to or greater than the weakness, the numerical value is doubled when applying the weak point. … This effect does not stack with the Combat Feat [Weakness Exploit]."

### 6.6 Multiplicador de effetivel — [Weakness Exploit], Core Rulebook II, p. 211

> "Gain Sage Level 7 — Doubles the effectiveness of hitting weak points. Effect: If the master performs a Monster Knowledge check with the Sage class and obtains a success value greater than or equal to the monster's weakness, the bonus generated by the weak point and the increment of damage is doubled for the master. For example, if the weak point is 'Accuracy +1', the bonus to the Accuracy will become +2, and if the weak point is 'Fire damage +3 points', the damage will be increased by +6. This effect only applies to the master; other allied characters will only benefit from the normal effect of the weak point."

También está listado en el índice de feats de Battle Mastery (p. 20 impresa) y duplicado en CR II (índice, p. 435: «Weakness Exploit… 210»). Casos especiales de datos del propio sistema (compendiums de hechizos): el hechizo de Druida ⏩△Nature Master (Monstrous Lore, p. 21) permite aplicar weak points **sin** poder usar [Weakness Exploit]; el hechizo Piercer (Divine) revela los weak points sin Monster Knowledge (sí permite Weakness Exploit); el hechizo Weakness (Magitech, nivel 6) añade un weak point aleatorio que **no** se duplica por [Weakness Exploit].

### 6.7 Universo de tipos — Abyss Breaker, pp. 35 y 41

- **AB p. 41 — «Type Determination Table»** (misma tabla que usa CR II, pp. 250/257 («The type should be selected from the 'Type Determination Table' (see p. 257)»)): los tipos definidos por el juego son **Earth, Water/Ice, Fire, Wind, Lightning, Energy, Slashing, Bludgeoning, Poison, Disease, Curse, Psychic**. Las debilidades de los monstruos usan exactamente este set (más `Accuracy`, `HP Recovery` y `Silver Weapon` como casos especiales).
- **AB p. 35 — apilamamiento de tipos:** "Essence Weaving [Type Infusion • X] grants multiple types connected by 'and' to weapon attack. Such attacks apply one type chosen from among the specified types that is most disadvantageous for each attack target. Normally, effects that grant different types do not stack (see CR I, p. 172, MA p. 74), but these Essence Weaving effects work like 'glue,' allowing such stacking."
  Referencia cruzada **CR I p. 172 / MA p. 74** (regla de no apilamiento de tipos): cita verificada indirectamente en AB p. 35; los textos completos de CR I p. 172 y MA p. 74 **no fueron leídos directamente** en este análisis.

### 6.8 Formato impreso de datos de monstruo («Rep/Weak»)

Bloques de datos impresos: `Rep/Weak: 10/13 Weak Point: Fire damage + 3 points` (p. ej. Abyss Breaker pp. 89–141), y para monstruos sin debilidad:

> "Rep/Weak: 4/- Weak Point: None" (Abyss Breaker, pp. 127–129 — los Dark Hunter NPC)

El guion (`-`) es la representación impresa de **"no tiene debilidad"**; el wiki lo conserva y el parser lo convierte en `0`. Monstrous Lore usa el mismo formato en sus bloques (p. ej. ML p. 104 Vampire Tetrahedron `Rep/Weak: 19/26 Weak Point: Accuracy +1`; ML pp. 184/216 con `Weakness Exploit` integrado en Sphinx/Endertuz).

### 6.9 Reglas no localizadas en los PDF

- **`Silver` (`Silver Weapon Damage +3`):** no se localizó la regla de debilidad a armas plateadas en los PDF consultados (11 monstruos; presumiblemente Daemons/Nosferatu y similares). Pendiente.
- **Checks de la clase Rider** (¿"Monster Knowledge" sin weak points?): la afirmación del código («Rider never discovers weaknesses») no se contrastó con la página de clase del manual. Pendiente.

---

## 7. Contraste con el sistema Foundry actual

### 7.1 Mapa de soporte por categoría

Clasificación sobre la implementación actual:
- **Parsea:** `parseWeaknessData()` (`damage-application.mjs:33-38`) reconoce `^([A-Za-z]+(?:\s+[A-Za-z]+)?)\s*\+\s*(\d+)` (máx. 2 palabras antes del `+`).
- **Mapea:** `categoryToDamageType()` (`damage-application.mjs:42-47`) solo reconoce `"physical damage"` → `physical` y `"magic damage"` → `magical`.
- **Soportado de punta a punta:** parsea + mapea + el flujo de daño del sistema emite ese tipo de daño.

| Categoría | Total | Parseable | Mapeado | Soportado punta a punta | Observación |
|-----------|------:|----------:|--------:|------------------------:|-------------|
| **FÍSICO** | 132 | 132 | 132 | 132 | `"Physical Damage…"` → `physical`;Defense lo reduce ( único tipo con canal completo) |
| **MAGIA** | 76 | 65 | 65 | 65 | solo en el orden `"Magic Damage +2"`; el invertido `"+2 Magic Damage"` (11) no parsea |
| **PRECISIÓN** | 69 | 69 | 0 | 0 | requiere bonificador de tirada de Precisión, no de daño (§7.2) |
| **FUEGO** | 117 | 116 | 0 | 0 | sin canal de tipo en `damageApplicationButton()`; `Skadi` (1) no parsea (entidad `&amp;`) |
| **AGUA/HIELO** | 43 | 0 | 0 | 0 | `Water/Ice …` — la `/` rompe la regex |
| **CURACIÓN COMO DAÑO** | 43 | 0 | 0 | 0 | frases entre paréntesis; magnitud única +4 en `Dragon Zombie` |
| **CONTUNDENTE** | 36 | 23 | 0 | 0 | formas con `type`/guion fuera del patrón de 2 palabras |
| **VIENTO** | 33 | 12 | 0 | 0 | formas con `type`/guion (21 de 33) fuera del patrón |
| **CORTANTE** | 28 | 12 | 0 | 0 | formas con `type`/guion (16 de 28) fuera del patrón |
| **RAYO** | 27 | 27 | 0 | 0 | `"Lightning damage +3 damage"` (Magireplica) parsea pero no mapea |
| **TIERRA** | 26 | 26 | 0 | 0 | sin canal de tipo en el sistema |
| **ENERGÍA** | 23 | 15 | 0 | 0 | 8 de 23 no parsean (`type`, orden invertido) |
| **PLATA** | 11 | 0 | 0 | 0 | 3 palabras (`Silver weapon…`); regla RAW pendiente (§6.9) |
| **NONE** | 48 | 0 | 0 | 0 | sin efecto que aplicar; `48` correcto por RAW |
| **Total** | **712** | **497** | **197** | **197** | 27,7 % de punta a punta |

**Totales:** parseables 497/712 (69,8 %); soportados de punta a punta 197/712 (**27,7 %**); no parseables 167; `"None"` 48 (correcto, sin efecto que aplicar).

### 7.2 Flujo actual de daño y desviaciones con RAW

`module/combat/damage-application.mjs`:

- **Defensa (líneas 11-21):** para `character`, suma de armaduras equipadas (`defence`/`magicalDefence`); para `monster`, `combatStyles[0].defense`; para mágico, 0.
- **Orden (líneas 99-105):** `applied = max(0, raw - defense)` y **después** `bonusApplied = max(0, applied + weaknessBonus)`.
  **Desviación RAW:** el bonus debe aplicarse **antes** de la Defense (§6.1: `max(0, raw + bonus − defense)`). Difieren cuando `applied < bonus`: ej. `raw=5`, defense=10, bonus=2 → RAW 0; código 2.
- **Mensaje de chat (líneas 113-114):** informa `applied` **sin** incluir el bonus; el jugador no ve el daño real infligido si `bonusApplied ≠ applied`.
- **Estado (líneas 54 y 105):** el bonus se aplica a cada ataque mientras `system.weaknessDiscovered === true` (no se consume) — compatible con RAW (el weak point vale toda la sesión; se aplica porque aplicándose).
- **Tipos:** `damageApplicationButton()` y el socket solo manejan `physical` y `magical` — no hay canal para los 9 tipos tipados del juego (§6.7), ni para `Accuracy +1` (bonificador de tirada de Precisión del atacante, cf. `monster-sheet.mjs:269-277` — las tiradas de Accuracy del monstruo no consideran debilidades) ni para `HP Recovery` o `Silver Weapon`.

### 7.3 Flujo actual de Monster Knowledge y desviaciones con RAW

`module/combat/monster-knowledge.mjs`:

- **Umbral (líneas 112-141):** tirada 2d6 + nivel de clase + INT, comparada contra `reputation` (revela stats) y `weakness` (revela el weak point). **Desviación menor RAW:** bajo RAW un éxito (SV ≥ weakness) aplica el weak point a todo el grupo (CR I p. 383); el código registra el estado en el Actor del monstruo al revelarlo (flags por species), no por party.
- **Rider (línea 127):** « Rider never discovers weaknesses ». Sin verificación RAW aún (§6.9).
- **Dark Hunter (líneas 33-35):** tratado igual que Sage para **cualquier clasificación**. Desviación RAW: AB p. 28 limita el Dark Hunter a **Daemons**; AB p. 31 (Monster Watch) lo amplía a Barbarous/Undead (requiere el weave), añade −4 a la debilidad de Daemons a nivel 5+ (piso: reputation) y **duplica** el valor aplicado a nivel 10+. Nada de esto está implementado.
- **Expiración:** `system.weaknessDiscovered` persiste y no expira. Desviación RAW: duración de una sesión (CR I p. 383; Ancient Blue p. 21) con las reglas de Ancient Blue (volver al [Base] = fin de la «one session»).
- **Weakness Exploit (CR II p. 211):** no implementado (ni el doble de Sage, ni el doble de Dark Hunter nivel 10+).

### 7.4 Estado actual del módulo (nueva observación)

Al momento de escribir este documento (2026-11-04), en la copia de trabajo (`D:\Foundry Assets\sword-world-25`) se observó:

- `node --check module/combat/monster-knowledge.mjs` **falla** con `SyntaxError: Unexpected identifier 'cls'` (líneas 45, 51, 56: `classes.some cls => …` — faltan los paréntesis). El módulo no puede cargarse.
- `sw25.mjs:18` importa `initializeMonsterKnowledge` de ese archivo, que **no está exportado**; `module/actor/monster-sheet.mjs:7` importa `canPerformMonsterKnowledge` y `recordMonsterKnowledge`, que no coinciden con las exportaciones actuales (`canPerformMonsterKnowledgeCheck`, sin `recordMonsterKnowledge`), y llama `rollMonsterKnowledgeCheck(actor, this.actor, section.id)` (3 argumentos; el módulo define 2).
- Se decidió **no reparar** el código en esta tarea (solo investigación/documentación). Documentado aquí para el seguimiento.

### 7.5 Parseo de texto (qué formas restan por normalizar)

Familias no parseables por la regex actual y su conteo (167 en total): `"+2 Magic Damage"` / `"+2 Magic damage"` (11); `Water/Ice` (43 — el `/` interrumpe el patrón); `HP Recovery` (43 — paréntesis y variaciones); `"Bludgeoning type damage…"` (13 — más de 2 palabras); formas Wind con `type` insertado o guion (21); formas Slashing con `type` o guion (16); `Energy type damage…` y `"+3 Energy damage"` (8); `Silver` (11 — tres palabras: `Silver weapon damage…`); `"Fire &amp; Earth…"` (Skadi, entidad HTML sin decodificar; cuenta como FUEGO). En cambio, `"Fire damage +3 damage"` y `"Lightning damage +3 damage"` **sí parsean** (2 palabras + número), pero su categoría no mapea.

---

## 8. Cuestiones pendientes

| # | Cuestión | Referencia |
|---|----------|-----------|
| 1 | Regla RAW de la debilidad a `Silver Weapon` (11 monstruos) | No localizada en los PDF consultados |
| 2 | Texto completo de las referencias cruzadas CR I p. 172, CR I p. 238 y MA p. 74 (no apilamiento de tipos; fundamentos de la comparación) | Referidas en AB p. 35 y en los bloques de datos; no leídas directamente |
| 3 | Reglas de clase Rider sobre Monster Knowledge (¿nunca obtiene weak points?) | Código del sistema (`monster-knowledge.mjs:127`); página de clase no localizada en CR I |
| 4 | Leer directamente Monstrous Lore «Part 4 Monster Data» (pp. 88–98): formato «Rep/Weak» y reglas de puntos débiles de monstruos | ML |
| 5 | Verificación wiki de los 45 humanoids restantes con `weakness = 0` (subcasos A/B específicos por página) | §5.3 |
| 6 | Redacción canónica de los `HP Recovery…` y decisión de magnitud +4 (Dragon Zombie) | AB pp. 97–101/139 vs datos extraídos |
| 7 | Semántica RAW de `Accuracy +1` como weak point (bonificador a las tiradas de Precisión de los atacantes del grupo contra el monstruo) y su aplicación posible en Foundry | CR I p. 383; feats de Battle Mastery |
| 8 | Decisión de diseño para los 9 tipos tipados (¿nuevo canal de `damageType`? ¿etiquetas propias?) | §7.1 |
| 9 | Páginas impresas exactas de Battle Mastery para los feats duplicados (índice de feats: p. 20 impresa = PDF 22) y del texto completo duplicado débils | BM / CR II p. 210–211 |
| 10 | Los errores de carga del módulo `monster-knowledge.mjs` (sintaxis y exports) — fuera del alcance de esta tarea | §7.4 |

---

## 9. Confirmación

**Confirmación:** Este documento es exclusivamente de investigación y documentación. No se ha modificado ningún archivo de código, datos de monstruos, compendios ni archivos de `sw25-library`; tampoco se ha sincronizado con FoundryPortable ni realizado commits.
