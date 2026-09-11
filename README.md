# Slop of the South

_(formerly Mijnstreek Drive; the Rails module is still `MijnstreekDrive`)_

A multiplayer arcade driving game set in the Westelijke Mijnstreek (Sittard, Geleen, Beek, Neerbeek,
Stein, Urmond, Brunssum and everything in between), built from real geodata.

Backend: Ruby on Rails 8.1 + PostgreSQL/PostGIS + Action Cable.
Frontend: Three.js as native ES modules via `importmap-rails` (no Node toolchain).

---

## 1. The plan

### 1.1 Play area

Bounding box (WGS84) covering all named places plus the villages between them
(Elsloo, Meers, Berg aan de Maas, Obbicht, Grevenbicht, Born, Limbricht, Guttecoven, Einighausen,
Munstergeleen, Spaubeek, Sweikhuizen, Puth, Schinnen, Oirsbeek, Amstenrade, Doenrade, Merkelbeek,
Schinveld, Jabeek, Bingelrade, Genhout, Kelmond, Geverik):

    lat 50.90 – 51.05   lon 5.70 – 6.02      (~17 km × 22 km ≈ 375 km²)

That is a lot of buildings (well over 100k). Everything is therefore cut into **500 m tiles**
that stream in around the player. Start development on a smaller "phase 1" box around
Sittard–Geleen (`lat 50.94–51.01, lon 5.78–5.90`) and widen later. Both boxes live in
`config/initializers/world.rb`.

### 1.2 Coordinate system

All world data is stored in **RD New (EPSG:28992)**, the Dutch national grid. It is in metres and
nearly distortion-free over Limburg, so 1 unit = 1 metre in Three.js with no per-frame maths.
PostGIS does the reprojection during import (`ST_Transform(..., 28992)`).

Game space is RD minus a fixed origin so floats stay small:

    game.x =  (rd.x - ORIGIN_X)        east
    game.z = -(rd.y - ORIGIN_Y)        south  (Three.js is y-up, right-handed)
    game.y =  elevation in metres NAP

### 1.3 Data sources

| Layer | Source | Notes |
|---|---|---|
| Roads, water, land use | OpenStreetMap via Overpass (MVP) or Geofabrik Limburg `.pbf` + `osm2pgsql` (full box) | `rake osm:fetch osm:import` |
| Buildings | **3D BAG** (3dbag.nl, TU Delft, CC BY 4.0) | LoD2.2 surfaces: the real roof planes and walls per building (`building_meshes`, ~12 faces per house), triangulated on the client. LoD1.3 parts are imported too as a fallback for the few buildings without a LoD2.2 model. `rake bag3d:fetch bag3d:import` downloads the GeoPackage tiles and loads them with `ogr2ogr`. |
| Buildings (fallback) | OpenStreetMap footprints | Only used where no 3D BAG building overlaps, i.e. across the German border. `height` / `building:levels` tags, fallback 6 m. |
| Place names | OpenStreetMap `place=*` nodes (towns, villages, wijken) | Drive the HUD street sign (nearest named road + nearest place) |
| Land cover & water | **BGT** `begroeidterreindeel` (meadows, arable fields, orchards, woods, lawns), `onbegroeidterreindeel` (yards, pavement), `waterdeel`, `vegetatieobject` (hedges), plus the grass verges from `road_surfaces` | Painted per tile into a 512 px terrain texture (fields keep a stable colour per polygon, with a pattern clipped inside the bigger ones); water is also drawn as a draped skin. Each polygon carries its BGT sub-kind (`plus-fysiekVoorkomen`: gras, heesters, bosplantsoen, klinkers, asfalt …), which picks a finer pattern and lets shrub beds grow bushes. Polygons under 6 m² are dropped. Area shares classify each tile into a biome: water, stad, woonwijk, dorp, bos, boomgaarden, akkerland, weiland, platteland (`LandCover.biome`). Orchards get hoogstam fruit trees on a 9 m lattice. |
| Province border | **Bestuurlijke Gebieden** (Kadaster) via PDOK OGC API Features, `provinciegebied` | `rake border:fetch` stores the Limburg polygon; `/api/world` serves it simplified to 25 m. Outside it the world is a wall of flames (`game/FlameWall.js`); crossing it burns you back to your last position inside. |
| Trees | **BGT** (Basisregistratie Grootschalige Topografie) via PDOK OGC API Features | `vegetatieobject_punt` gives every registered tree (`plus_type = boom`); woodland polygons from `begroeidterreindeel` (loofbos, naaldbos, gemengd bos, houtwal) are filled with deterministically scattered trees (`ST_GeneratePoints`). `rake bgt:fetch bgt:import`. |
| Terrain | **AHN** (Actueel Hoogtebestand Nederland) DTM via PDOK WCS | OSM has no elevation. AHN is 0.5 m lidar; the WCS resamples it to the 10 m grid on request, `gdal_fillnodata` fills the holes under buildings and water. Zuid-Limburg is genuinely hilly — 27 m at the Maas to 114 m on the plateau within the phase-1 box. |
| Traffic signs | **NDW** Verkeersborden (Nationaal Dataportaal Wegverkeer, `traffic-signs/v4/current-state`) | The API answers with the whole country as one 1.2 GB GeoJSON (its filters are ignored), so `rake ndw:fetch` downloads it once and `rake ndw:import` streams it through `jq --stream` into `traffic_signs` for the world bbox (227k signs in Limburg). Every sign face is painted from its RVV code and value on a canvas (`game/Signs.js`: A1 speed discs, B6 yield, G11 cycle path, E4 parking, H1 town entry, J warnings, onderborden with their text …) and faces against the traffic it applies to (`bearing` + 180°). Signs at one spot share a pole. |
| Lamp posts | **BGT** `Paal` with `plus-type = lichtmast` (bulk extracts, `BGT_BULK_TYPES=paal rake bgt:bulk_fetch bgt:paal_import`) | 101k masts in Limburg, arm turned towards the nearest road, 9 m on main roads, 6 m elsewhere. `Paal` is an optional IMGeo object: the Parkstad municipalities (Heerlen, Kerkrade, Landgraaf, Brunssum …) deliver none; there OSM `highway=street_lamp` (`rake osm:pbf_points`) is the sparse fallback. |
| Traffic lights | **BGT** `Paal` with `plus-type = verkeersregelinstallatiepaal` (990 poles) + OSM `highway=traffic_signals` nodes (2.4k) | Each BGT pole becomes a signal head facing the traffic that approaches it (side of the road decides the direction); where BGT has no poles the OSM node gets one pole per approaching road. Heads run a shared 40 s cycle on the wall clock, phased by axis, so all players see the same colours. Live iVRI state via Talking Traffic is a later stretch goal. |


Everything above is open data. Keep attribution ("© OpenStreetMap contributors", "AHN", "3D BAG", "BGT", "NDW")
in the game's about screen.

### 1.4 Pipeline

    Overpass/PBF ──► PostGIS (roads, buildings; EPSG:28992)
    AHN GeoTIFF  ──► gdalwarp ──► data/dem.asc (10 m ASCII grid, EPSG:28992)
                                    │
                                    ▼
                      rake tiles:build ──► public/tiles/{tx}_{ty}.json
                                            ├── heights[51×51]   (10 m spacing)
                                            ├── roads[]          {kind, width, pts}
                                            ├── buildings[]      {base, height, footprint}   (OSM / fallback boxes)
                                            ├── meshes[]         {id, roof, o, f: [[label, ring…]…]} (3D BAG LoD2.2 faces, cm offsets)
                                            ├── trees[]          [x, z, kind, height]   (BGT; kind 0 street tree, 1 broadleaf wood, 2 conifer, 3 fruit tree)
                                            ├── cover[]          [code, ring…]          (BGT land cover, dm offsets from the tile corner; painted)
                                            │                    water: [30, level | null, ring…] — level = flat surface over a carved bed
                                            ├── cover_sub[]      one BGT sub-kind per cover entry (0 = none): grass, shrubs, klinkers, asfalt …
                                            ├── furniture        {lamps: [x, z, dir, h], signals: [x, z, face, group], signs: [x, z, face, code, black?, text?]}
                                            └── biome            "akkerland" | "woonwijk" | …

Tiles are static JSON served by nginx/Rails' static file server — no DB hit while playing.

### 1.4 a Roads in the terrain

The height on the wire (`roads[].pts[i][2]`, `junctions[][2]`) **is the road surface level**. `RoadBuilder` samples the
terrain along each way, smooths it (60 m box filter twice for motorways/trunks/primaries, 30 m once for the rest), pins
it at junction nodes so meeting roads share a height, and clamps it to at most `CUT_LIMIT` 0.25 m below and
`FILL_LIMIT` (6 m major, 1.5 m minor, 0.4 m cycleway/track) above the terrain; bridges float. The tile's height grid is
then deformed: within `max(width/2 + 0.5, 5)` m of the centreline the terrain *is* the road level (the bed), the next
`VERGE` 2.5 m sit a `CURB` 0.12 m higher (the sidewalk strip), and over `SHOULDER` 6 m more it blends back to nature.
Junction patches get the same seat. On the client `Roads.js` draws the carriageway `ROAD_LIFT` 0.05 m above the higher
of the road level and the terrain under each vertex (the 10 m grid smears the curb across the ribbon edge, so ribbons
follow the terrain where it pokes up), the procedural sidewalks `CURB` above that, and `ChunkManager.heightAt` gives
the car the same surface, blended into the terrain over ±0.3 m at the ribbon edge so the wheels roll over the curb.
Order from low to high: road < painted pavement / verge < sidewalk ribbon. `test/services/road_builder_test.rb` pins
the numbers down; rebuild tiles (`tiles:clean tiles:build`) after touching any of it.

### 1.4 b Water

The AHN height inside water is the water *surface*, so the tile builder carves a bed under lakes, harbours, rivers,
canals and the wider watercourses (`TileBuilder#water_beds`): depth grows with the distance from the shore
(0.6 m per metre) up to a per-kind depth (Maas/rivier 6 m, kanaal 5 m, lakes 3 m). Each such water body gets a flat
surface at its own level (median terrain height inside it) drawn by a water shader (`game/Cover.js`): rippling
normals, the sky reflected by Fresnel (colours from DayNight), sun glitter, and transparency over the dark-painted bed.
Ditches and brooks stay draped on the terrain. Drive in and you sink.

### 1.4a Time of day

A full day takes 6 real minutes (`game/DayNight.js`, `DAY_SECONDS`), on the wall clock so every player sees the same
time; the HUD shows the game clock. Sunrise 06:00, noon 12:00, sunset 18:00, twilight until about 19:00. The sun
light swings east → south → west and gives way to a faint moon; sky, fog and hemisphere light darken with it. The sky
is a shaded dome around the camera (horizon → zenith gradient per phase, a glow banked around the sun at dawn and
dusk, stars once the sun is well below the horizon); the fog takes the horizon colour so the land fades into it. The
sun and the moon are visible as sprites far out along their compass directions on a flattened arc (2°–18° up, since
the chase camera only sees ~22° above the horizon); the sun reddens and fades at the horizon, the moon rises low in
the opposite sky as the sun sets. Face them to see them: east in the morning, south at midday, west in the afternoon. A
`darkness` value (0 day … 1 night) switches on the street lamps (glowing heads plus an additive light pool on the
ground, sodium orange on streets, LED white on main roads), makes sign faces retro-reflective and turns on car lights:
two spotlights on the player's car, emissive headlights and tail lights on every car, brake lights while braking
(the brake flag travels with the position over Action Cable). `?time=22.5` freezes the clock at that hour.

### 1.5 Multiplayer

Every other player carries a beacon (`game/RemoteCars.js`): a label with their name and distance in km floating in the
sky above their car with a line down to it. It is always in view: labels of players farther than 3 km are drawn 3 km
out in their direction and climb with the distance, so you can head towards anyone in the province. Your own name
comes from `localStorage.driverName`, settable with `?name=Pietje`.

- One `GameChannel` per room (default room `"main"`).
- Clients send `move` at 10 Hz: `{x, y, z, yaw, speed}`. Server stamps it with the player id and
  broadcasts to the room. Client-authoritative — fine for a fun game with friends; cheating is
  a "later" problem.
- Remote cars are interpolated ~100 ms behind real time so they move smoothly.
- Presence: `subscribed` / `unsubscribed` broadcast `join` / `leave`.
- Solid Cable (the Rails 8 default) is enough for a handful of players. For dozens+, switch to
  Redis or AnyCable — the client code doesn't change.

### 1.6 Frontend architecture

    entrypoints/game.js      boot, game loop
    game/World.js            renderer, camera, sky, fog, lights
    game/ChunkManager.js     loads/unloads tiles in a radius around the car
    game/TerrainTile.js      heightmap → mesh, bilinear heightAt(x, z)
    game/Roads.js            polylines → draped ribbons
    game/Buildings.js        footprints → extruded, merged meshes (OSM / fallback)
    game/BuildingMeshes.js   3D BAG LoD2.2 faces → triangulated meshes, one per material, with a facade UV
    game/BuildingTextures.js brick, pantiles, bitumen and the facade cell: one window in one bay by one storey
    game/Textures.js         the procedural kit: canvas textures tiled by the metre, plus speckle/grain/cracks/bricks
    game/Environment.js      the ambient light, PMREM-baked from the sky DayNight draws
    game/Outline.js          the cartoon outline pass, and who opts out of it
    game/Bench.js            ?bench=bos|dorp|veld: frame cost at a fixed spot
    game/Cover.js            land cover → per-tile canvas texture on the terrain; water polygons → draped skins
    game/Trees.js            procedural branching trees, a few seeded variants per kind, instanced per tile;
                             variant, rotation, width and tint come from the tree position, so every tree is stable
    game/Locator.js          nearest named road + nearest place for the street sign
    game/FlameWall.js        animated fire curtain along the province border; even-odd inside test for the burn-back
    game/Minimap.js          map drawn from our own data (MapBuilder → public/map): overview + 1 km detail cells;
                             M expands, drag pans, wheel zooms, F fits the bounds, click teleports
    game/Vehicle.js          arcade car: body-frame velocity (speed + lateral), grip model, handbrake drift with
                             mini-turbo charge, nitro meter (Shift, drift payout, road pads), shared car mesh
    game/Suspension.js       four wheels on their own ground, spring-damped body heave/pitch/roll, wheel spin + steer
    game/Camera.js           spring-damped chase camera: sits behind a blend of nose and velocity, speed/boost FOV
    game/VehicleFx.js        pooled tyre smoke while sliding, exhaust flames while boosting (local and remote cars)
    game/Pickups.js          boost pads placed deterministically per tile from its roads; ring + beam, local respawn
    game/Tuning.js           every feel constant in one object (window.slop.tuning), smoothing helpers, seeded RNG
    game/Input.js            keyboard
    game/Network.js          Action Cable
    game/RemoteCars.js       interpolation of other players, their wheels, smoke and flames, their vehicle meshes
    game/Beacon.js           sky label with a line down: other players and the parade float
    game/Round.js            the round as the server tells it: town, route, obstacles, clock offset, action cooldown, HUD
    game/Parade.js           the praalwagen on its route (position from the shared clock), the red ribbon, the beacon
    game/Destructibles.js    every object a player can flatten: 25 m grid, hit tests, collapse/hide, rubble heaps
    game/Combat.js           ramming, rubble, the six tricks, projectiles, explosions and knockback, `hit` batches
    game/Effects.js          flashes, debris, dust, confetti, camera shake, sprite pools
    game/Scatter.js          a carpet of grass tufts around the car plus bushes and reeds per tile; bushes squash under you
    game/Vehicles.js         the roster (specs + box-built meshes), game/Picker.js the six cards
    game/LoadingScreen.js    town photo, name and story between rounds; game/Music.js the YouTube player

### 1.7 Milestones

1. **Drive on terrain** — flat tiles, one car, WASD, chase camera. *(this scaffold)*
2. **Real roads & buildings** — Overpass import for the phase-1 box; tiles stream. *(done: 6.3k roads, 60k buildings, street sign HUD)*
3. **Real terrain** — AHN heights; buildings sit correctly on slopes. *(done: `dem:fetch dem:build`, 10 m grid from PDOK WCS)*
4. **Multiplayer** — see each other drive; name tags. *(channel + client already scaffolded)*
5. **Feel** — sound, skid marks, better car model, day/night, collisions with buildings.
6. **Game** — *(done: the vastelaovend parade, see 1.8)*. Later: time trials, leaderboards, a "deliver the vlaai" mode.
7. **Scale** — full bounding box (WORLD_BBOX=full for every fetch task); the Maas and Julianakanaal lie just outside the phase-1 box. *(trees, water, land cover done via BGT)*

### 1.8 Vastelaovend: the parade round

A Blast Corps-style co-op round, fifteen minutes each. A praalwagen rolls in a straight line across a 2.5 km square
around a random Limburg town; if it reaches any standing building, tree, lamp post, traffic light or sign the
parade is stuck and the round is lost. Players clear the route together. Flattened buildings leave rubble that has
to be cleared too. The float plays a vastelaovend playlist, louder the closer you are (N mutes).

**Rounds.** `Game::RoundManager` (lib/game) owns the round per room from a thread that ticks four times a second,
started by the first subscription so it lives in the Puma process (the development cable adapter is in-process):
idle → vote (15 s) → intermission (15 s, the loading screen) → running → ended (8 s) → vote. The vote offers four
random towns; players pick one or type another, which the server looks up in `places` and adds to the list, and the
most voted town (ties and silence fall to chance) becomes the next arena. `Game::Arena` takes that town (or a random
one) inside the province, draws the route through it at a random heading, lists everything in the float's
6 m corridor with the distance at which its nose arrives (PostGIS), pulls the start back along the line until the
float has 120 m of clear road before the first obstacle (checking the added stretch too), prefers corridors with
15 to 250 obstacles, finds a spawn road, and asks `Game::TownInfo` for the town's
Wikipedia paragraph and photographs. The float's position is a pure function of the start time and speed, so the
clients render it from a clock offset (`now` on every manager message) without traffic. `Game::Round` owns hit
points: a client reports damage with the object's size-based maximum, buildings crumble to rubble at zero (half
their points back) and then to gone, everything else goes at once; verdicts leave in one coalesced `object`
message per tick. Every new town restores the world: the clients drop and re-stream their tiles.

**Objects.** Keys: `m:<BAG id>` for LoD2.2 meshes (with a 2D footprint `fp` in the tile), `b:<id>` for extruded
buildings, and `t/l/g/s:<dm x>,<dm z>` for trees, lamps, traffic lights and signs from their tile coordinates,
which both sides round to a decimetre. The tile builders register a handle per object (vertex range or instance
index) and `Destructibles.js` keeps them in a grid for the car and the weapons.

**Vehicles.** Trike (fast, one rocket launcher, a missile every 2.5 s, barely dents anything itself), monstertruck
(as fast, jumps and crushes on landing, and its flanks do two and a half times the ramming damage of its nose, so
drift into the houses) and bulldozer (slow, grinds through anything in front of it, clears rubble in one pass, and E
lifts or drops the blade for an extra slam on the building it touches). Ramming damage grows with the square of the
speed into the wall. A shared action (teleport from the map or vehicle switch) has a minute of cooldown, reset at
every new town; switching is free between rounds. Explosions shove nearby cars, nobody dies.

**Protocol.** Server → client: `sync` (on subscribe), `round` (status changes), `object`, `end`, `teleport` and
`switch` verdicts, plus the relayed `move` (with `vehicle`, `drift`, `boost`) and `fire`. Client → server: `move`,
`hit {hits: [{key, damage, max}]}`, `fire`, `teleport {x, z}`, `switch {vehicle}`. Tunables are the constants at
the top of `lib/game/*.rb`, `Vehicles.js` and `Combat.js`. `bin/rails test` covers the round logic and the channel.

---

## 2. Setup

```bash
# System deps
brew install gdal                          # ogr2ogr, gdalwarp, gdal_fillnodata; PostgreSQL + PostGIS via Postgres.app or brew

rails new mijnstreek-drive -d postgresql --skip-jbuilder
cd mijnstreek-drive
# copy the files from this scaffold over the generated app, then:
bundle add activerecord-postgis-adapter importmap-rails
bin/rails importmap:install
# three.js and its addons are vendored into vendor/javascript (see config/importmap.rb)
```

Edit `config/database.yml` and set `adapter: postgis` for every environment.

The world is the province of Limburg by default (`WORLD_BBOX=limburg`; `phase1` = Sittard–Geleen, `full` = the
Mijnstreek box). Every task below works on that area.

```bash
bin/rails db:create db:migrate
bin/rails border:fetch         # Limburg province polygon (PDOK) → boundaries table; the edge of the world
bin/rails osm:pbf_fetch        # Geofabrik limburg-latest.osm.pbf (100 MB)
bin/rails osm:pbf_import       # → roads (101k) and places (1k) via ogr2ogr
bin/rails bag3d:fetch          # 3D BAG GeoPackage tiles for the box → data/bag3d/tiles (1075 tiles, ~2.5 GB gz / 13 GB)
bin/rails bag3d:import         # → PostGIS buildings (LoD1.3 parts) and building_meshes (LoD2.2)
bin/rails bgt:bulk_fetch       # BGT extracts per municipality via PDOK's download API → data/bgt/bulk/*.zip (~5 GB)
bin/rails bgt:bulk_import      # → land_covers (terrain, pavement, water, hedges) and the registered trees; SKIP_TREE_FILL=1 leaves the woods alone
bin/rails bgt:tree_fill        # → scatter trees through the woods and orchards already in land_covers (ONLY=woods,orchards)
BGT_BULK_TYPES=paal bin/rails bgt:bulk_fetch   # lamp posts, signal poles, sign posts → data/bgt/bulk/*-paal.zip (18 MB)
bin/rails bgt:paal_import      # → poles (101k lamp posts, 990 signal poles …)
bin/rails osm:pbf_points       # → poles: OSM traffic_signals nodes, signalised crossings, fallback street lamps
bin/rails ndw:fetch            # NDW traffic-sign register, all of NL (1.2 GB) → data/ndw/current-state.json
bin/rails ndw:import           # → traffic_signs inside the world bbox (227k), streamed with jq
bin/rails dem:fetch            # AHN terrain model from PDOK WCS, chunked → data/dem_raw.tif (10 m)
bin/rails dem:build            # fill holes, convert → data/dem.raw + dem.json (binary, read lazily)
bin/rails tiles:build          # → public/tiles/*.json for every tile inside the province (~9k)
bin/rails map:build            # → public/map/overview.json + 1 km cells for the minimap (also built on demand)
bin/dev                        # Rails (Puma on :3000)
```

For a small area (`WORLD_BBOX=phase1`) the paged alternatives still work: `osm:fetch osm:import` (Overpass) and
`bgt:fetch bgt:import` (OGC API Features).

Edit `config/database.yml` and set `adapter: postgis` for every environment.

Open http://localhost:3000 in two browser windows and drive.

### Local setup notes

- No Node needed: JavaScript is served as ES modules through `importmap-rails` and Propshaft. Imports use bare
  specifiers (`game/World`, `three`, `three/addons/...`) that `config/importmap.rb` resolves; relative imports would
  bypass the digested asset paths, so keep using bare specifiers.
- Three.js is vendored by hand (single-file jsDelivr `+esm` bundle) because the jspm build that `bin/importmap pin`
  downloads is split into chunk files. To add an addon, download it into `vendor/javascript` and pin it under
  `three/addons/...` — see the comment in `config/importmap.rb`.
- `osm:fetch` retries with backoff when the public Overpass server answers 429/504 (common). Set `OVERPASS_URL`
  to use a mirror, e.g. `OVERPASS_URL=https://maps.mail.ru/osm/tools/overpass/api/interpreter bin/rails osm:fetch`.
  Downloads are cached per cell in `data/osm/`, so rerunning only fetches what is missing.
- The `json` gem is pinned below 3.0 in the Gemfile: json 3.x made `JSON.parse` keyword-only, and Rails 8.1.3 still
  passes a positional options hash when reading signed cookies. Remove the pin once Rails ships the fix.
- `config/cable.yml` uses the `async` adapter in development (Rails default, in-process, fine for one server process)
  and Solid Cable in production.
- Tiles are requested from `public/tiles/` first and fall back to `/api/tiles/:tx/:ty`, which builds the tile and caches it
  on disk, so an empty database yields a flat 40 m NAP world and a 404 per tile in the dev log on first load.
- With LoD2.2 buildings a dense town tile is about 1 MB of JSON (roughly 100 MB for phase 1). Fine locally; serve
  `public/tiles` gzipped (or move to a binary tile format) before putting it on the internet.
Controls: W/↑ accelerate, S/↓ brake/reverse, A/D or ←/→ steer, Space handbrake, Shift boost, E trick, V vehicle
picker (1–6 pick), N music, R reset to road, M expand the minimap (drag to pan, scroll to zoom, F fits the whole
area, click to teleport, Esc closes). `?spawn=x,z,yaw` in the URL spawns at game coordinates, `?time=13` freezes
the clock.

**Outlines** (`game/Outline.js`): three's `OutlineEffect` draws an inverted hull around buildings, cars, the float
and the rubble. It is a second pass, so everything else opts out — the ground, roads, water, the sky and the sign
faces by hand where their material is made, and every instanced mesh (trees, grass, lamp posts, pads) as its tile is
built, because the addon offsets the hull with the model-view matrix alone and would place an instance's outline
wrongly. In the densest village that costs +80 draw calls and +0.27 M triangles on 578 / 2.36 M. `slop.tuning.light.outline.on`
turns it off live.

**Bench** (`?bench=bos|dorp|veld`, `game/Bench.js`) parks the car at a fixed spot in free roam, waits for the tiles,
watches two seconds of ordinary frames and then measures 300 renders, reading a pixel back each time so the GPU is
actually waited for. `slop.bench.result` holds the frame and render percentiles plus the draw calls, triangles,
programs and texture counts; `?frames=` and `?extra=` shorten it. Take the milliseconds in a real browser —
`script/browse.rb` runs a software rasteriser, where only the counts mean anything. Baseline counts there:

| spot | draw calls | triangles | programs | textures |
|---|---|---|---|---|
| `veld` open farmland | 254 | 1.89 M | 15 | 55 |
| `dorp` densest village tile | 639 | 2.89 M | 17 | 165 |
| `bos` conifer wood | 201 | 5.06 M | 13 | 17 |

**Vrij rijden** (`?vrij`, or the link in the vehicle picker) turns the round off: no server connection, so no
loading screen, no vote, no teleport to another town every quarter of an hour and no world reset. A map click
teleports straight away with no cooldown, any vehicle can be picked at any time, `,` and `.` wind the clock an hour,
and damage is judged on your own machine with the rule from `Game::Round#hit`, so buildings still fall. It is how
the world is looked at while working on how it looks.

### Driving

- **Drift**: Space while steering above ~30 km/h kicks the rear out (`grip` drops to 0.22); steer into the slide to
  widen it, counter-steer to trim it; let go of Space to hook up again in about 0.4 s. Sharp steering above 80 km/h
  slides mildly on its own. The HUD shows `DRIFT` with three pips filling at 0.7 / 1.5 / 2.5 s of slide; releasing
  pays out a mini-turbo (0.5 / 0.9 / 1.4 s of free boost plus 12 % meter per pip). A wall ends a drift without payout.
- **Boost**: Shift burns the orange meter (3 s from full, trickles back in 25 s); top speed rises 28 %, acceleration
  90 %, the camera pulls back and widens, flames come out of the exhaust. Blue rings with a light beam on straight
  stretches of through and residential roads (every 300–500 m, never on junctions or bridges) fill 35 % of the meter
  and give a short kick; they come back after 20 s (locally).
- **Suspension**: the body floats on springs over four wheels that each rest on their own ground: it dives when braking,
  lifts when launching, leans outward in corners and drifts, and bobs over curbs and bridge ramps.
- **Camera**: critically damped springs for position, aim and yaw; at speed it sits behind the velocity rather than the
  nose so a drift is visible; distance, height and field of view grow with speed and boost; it never sinks below the
  ground.
- Everything is tunable live: `slop.tuning.drift.gripDrift = 0.3` etc. in the console (`game/Tuning.js`).
