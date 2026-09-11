import * as THREE from "three"
import { World } from "game/World"
import { ChunkManager } from "game/ChunkManager"
import { updateSignals, setNightLevel } from "game/Furniture"
import { setSignsNight } from "game/Signs"
import { DayNight } from "game/DayNight"
import { updateWater } from "game/Cover"
import { Vehicle } from "game/Vehicle"
import { Input } from "game/Input"
import { Network } from "game/Network"
import { RemoteCars } from "game/RemoteCars"
import { Locator, nearestPointOnRoads } from "game/Locator"
import { Minimap } from "game/Minimap"
import { FlameWall } from "game/FlameWall"
import { Round } from "game/Round"
import { Parade } from "game/Parade"
import { LoadingScreen } from "game/LoadingScreen"
import { Music } from "game/Music"
import { vehicleSpec } from "game/Vehicles"
import { Picker } from "game/Picker"
import { Destructibles } from "game/Destructibles"
import { Combat } from "game/Combat"
import { Effects } from "game/Effects"
import { VehicleFx } from "game/VehicleFx"
import { Pickups } from "game/Pickups"
import { TUNING } from "game/Tuning"

async function main() {
  const config = await (await fetch("/api/world")).json()
  const homeSpawn = { ...config.spawn }      // the world spawn, kept as the fallback when a URL spawn is outside the border
  // ?spawn=x,z[,yaw] teleports to game coordinates (handy for exploring the countryside)
  let urlSpawn = false
  const spawnParam = new URLSearchParams(location.search).get("spawn")
  if (spawnParam) {
    const [x, z, yaw = 0] = spawnParam.split(",").map(Number)
    if (Number.isFinite(x) && Number.isFinite(z)) { config.spawn = { x, z, yaw }; urlSpawn = true }
  }
  const container = document.getElementById("game")
  const playerId = container.dataset.playerId
  const el = (id) => document.getElementById(id)

  const world   = new World(container)
  const effects = new Effects(world.scene)
  const index   = new Destructibles(effects)                // every object a player can flatten, in a grid
  const pickups = new Pickups()                             // boost pads, placed per tile from its roads
  const chunks  = new ChunkManager(world.scene, config, { onTile: (t) => { index.indexTile(t); pickups.addTile(t) }, onDrop: (t) => { index.dropTile(t); pickups.dropTile(t) } })
  index.heightAt = (x, z) => chunks.heightAt(x, z)
  world.setHeightAt((x, z) => chunks.heightAt(x, z))
  const input   = new Input()
  const car     = new Vehicle(config.spawn, vehicleSpec(localStorage.getItem("voertuig") ?? "trike"))
  let carFx     = new VehicleFx(car.mesh, effects.smoke)
  const combat  = new Combat({ scene: world.scene, index, effects, heightAt: (x, z) => chunks.heightAt(x, z), car, send: (action, data) => net.send(action, data) })
  const remotes = new RemoteCars(world.scene, effects.smoke)
  const dayNight = new DayNight(world)
  const parade  = new Parade(world.scene)
  const loading = new LoadingScreen(el("laden"))
  const music   = new Music(el("muziek"))
  const burnEl = el("burn")
  const burn = (ms) => { burnEl.classList.add("on"); setTimeout(() => burnEl.classList.remove("on"), ms) }
  let placed = false          // car and camera snapped onto the terrain once the spawn tile is in
  let snapToRoad = urlSpawn   // after a map teleport or a ?spawn= URL: move onto the nearest street once its tile is in
  const teleport = (x, z, yaw = car.yaw) => { car.reset({ x, z, yaw }); placed = false; snapToRoad = true; burn(400) }
  const voertuigEl = el("voertuig-naam"), hintEl = el("voertuig-hint")
  const applySpec = (spec) => {
    world.scene.remove(car.setSpec(spec)); world.scene.add(car.mesh)
    carFx = new VehicleFx(car.mesh, effects.smoke)
    localStorage.setItem("voertuig", spec.id)
    voertuigEl.textContent = spec.naam; hintEl.textContent = spec.ability.hint
    placed = false
  }
  voertuigEl.textContent = car.spec.naam; hintEl.textContent = car.spec.ability.hint
  const ladenEl = el("laden")
  // the picker: free at the first join and behind the loading screen; mid-round it goes through the server's action
  const picker = new Picker(el("kiezer"), { onPick: (spec, free) => { if (free) applySpec(spec); else net.send("switch", { vehicle: spec.id }) } })
  const lobby = (open) => { ladenEl.classList.toggle("met-kiezer", open); if (open) picker.show(car.spec.id, true); else picker.hide() }

  // the round: a new town restores the world and drops everyone on its spawn road behind the loading screen (a page
  // load mid-round too, unless the URL asked for a spot)
  const round = new Round(playerId, { actie: el("actie"), banner: el("banner"), bannerTitel: el("banner-titel"), bannerSub: el("banner-sub"), flits: el("flits"),
                                       route: el("route"), routeKop: el("route-kop"), routeGedaan: el("route-gedaan"), routeIconen: el("route-iconen"), routeOptocht: el("route-optocht") }, {
    onRound: (body, { fresh, live }) => {
      if (fresh) {
        chunks.reload(); index.resetRound(); combat.reset()
        config.spawn = body.spawn
        if (live || !urlSpawn) teleport(body.spawn.x, body.spawn.z, body.spawn.yaw)
        if (body.status !== "ended") { loading.show(body.arena, body.id); lobby(true) }
      }
      index.applyAll(body.obstacles.concat(body.objects))
      parade.setRound(round)
      if (body.status === "ended") { loading.hide(); lobby(false) }
    },
    onObjects: (list) => index.applyAll(list),
    onEnd: (msg) => { parade.hide(); combat.enabled = false; effects.confetti(msg.x, chunks.heightAt(msg.x, msg.z) + 4, msg.z) },
    onAction: (msg) => {
      if (msg.type === "teleport") teleport(msg.x, msg.z)
      if (msg.type === "switch") { applySpec(vehicleSpec(msg.vehicle)); round.flash(`Je rijdt nu een ${car.spec.naam.toLowerCase()}`) }
    },
  })
  picker.show(car.spec.id, true)
  window.slop = { world, dayNight, car, remotes, chunks, round, parade, index, combat, effects, pickups, music, loading, picker, applySpec, tuning: TUNING }   // for poking at the scene from the console
  // ?name=Pietje sets the driver name other players see above your car (kept in localStorage)
  const nameParam = new URLSearchParams(location.search).get("name")
  if (nameParam) localStorage.setItem("driverName", nameParam.trim().slice(0, 16))
  const net = new Network({ room: "main", onMessage: (m) => {
    if (m.type === "move" || m.type === "join" || m.type === "leave") { if (m.id !== playerId) remotes.receive(m); return }
    if (m.type === "fire") { if (m.id !== playerId) combat.remoteFire(m, remotes.get(m.id)?.mesh); return }
    round.receive(m)
  } })
  const locator = new Locator(config.places)
  const minimap = new Minimap(el("minimap"), config, {
    // a map click asks the server for a teleport; the car moves when the answer comes back
    onTeleport: (x, z) => {
      if (!round.running) { round.flash("Teleporteren kan alleen tijdens een ronde"); return false }
      if (!round.canAct()) { round.flash(`Actie beschikbaar over ${round.countdown()}`); return false }
      net.send("teleport", { x, z })
    }
  })

  world.scene.add(car.mesh)
  const wall = config.border?.length ? new FlameWall(config.border) : null
  if (wall) world.scene.add(wall.mesh)
  let lastInside = null       // last position inside the border, to fall back to after burning

  const kmh = el("kmh"), playersEl = el("players"), clockEl = el("clock"), cooldownBar = el("cooldown-bar")
  const boostEl = el("boost"), boostFill = el("boost-fill"), driftEl = el("drift"), pipsEl = el("drift-pips")
  let shownLevel = -1, shownDrift = null, lastKmh = -1, lastMeter = -1, lastBoostOn = null   // DOM writes only on change
  const onPickup = (p) => {
    car.addBoost(TUNING.boost.pickupFill, TUNING.boost.pickupBurst)
    effects.flash(p.x, p.y + 0.6, p.z, 1.6); effects.shake(0.04)
    boostEl.classList.add("pop"); setTimeout(() => boostEl.classList.remove("pop"), 200)
  }
  const signEl = el("sign"), streetEl = el("sign-street"), placeEl = el("sign-place"), biomeEl = el("biome")
  const timer = new THREE.Timer()
  let netTimer = 0, signTimer = 0, borderTimer = 0
  const heightAt = (x, z) => chunks.heightAt(x, z), tileIndex = (x, z) => chunks.tileIndex(x, z)

  function frame(now) {
    timer.update(now)
    const dt = Math.min(timer.getDelta(), 1 / 20)

    chunks.update(car.x, car.z)
    updateSignals()
    const darkness = dayNight.update()
    car.setNight(darkness); remotes.setNight(darkness); setNightLevel(darkness); setSignsNight(darkness)
    updateWater(dayNight.env, timer.getElapsed())
    if (input.toggleMap) minimap.toggle()
    if (input.mute) round.flash(music.toggle() ? "Muziek uit" : "Muziek aan")
    if (input.pick) {
      if (!round.running) picker.show(car.spec.id, true)
      else if (round.canAct()) picker.show(car.spec.id, false)
      else round.flash(`Actie beschikbaar over ${round.countdown()}`)
    }
    const digit = input.digit
    if (digit) picker.digit(digit)
    if (chunks.ready(car.x, car.z)) {
      if (input.reset) { car.reset(config.spawn); placed = false }
      if (!placed) {
        if (snapToRoad) {
          const p = nearestPointOnRoads(car.x, car.z, chunks.roadsAround(car.x, car.z))
          if (p) { car.x = p.x; car.z = p.z; car.yaw = p.yaw }
          snapToRoad = false
        }
        car.y = chunks.heightAt(car.x, car.z)
        car.mesh.position.y = car.y
        world.followCamera(car, 1e3)   // huge dt → camera jumps straight behind the car instead of rising out of the ground
        placed = true
      }
      car.integrate(dt, input)
      combat.enabled = round.running
      combat.collide(car, dt)
      car.settle(heightAt)
      combat.abilities(car, input, dt)
      carFx.update(car, dt)
      pickups.collect(car, tileIndex, onPickup)
    }
    pickups.update(dt)
    combat.projectiles(dt)
    // the edge of the world: cross the province border and you burn back to where you were
    if (wall) {
      wall.update(timer.getElapsed())
      borderTimer += dt
      if (borderTimer > 0.2) {
        borderTimer = 0
        if (wall.inside(car.x, car.z)) lastInside = { x: car.x, z: car.z, yaw: car.yaw }
        else {
          car.reset(lastInside ?? homeSpawn)
          car.yaw += Math.PI                                      // turn around
          placed = false
          burn(600)
        }
      }
    }
    world.followCamera(car, dt)
    effects.update(dt, world.camera)
    remotes.update(car, world.camera)
    parade.update(round.now(), dt, chunks, car, world.camera)
    if (loading.open && round.running && chunks.readyFraction(car.x, car.z) >= 1) { loading.hide(); lobby(false) }

    netTimer += dt
    if (netTimer > 0.1) { netTimer = 0; net.sendMove(car.state()); combat.flush() }

    signTimer += dt
    if (signTimer > 0.25) {
      signTimer = 0
      locator.update(car.x, car.z, chunks.roadsAround(car.x, car.z))
      placeEl.textContent = locator.place ?? ""
      streetEl.textContent = [locator.district, locator.street].filter(Boolean).join(" · ")
      signEl.hidden = !(locator.place || locator.street)
      biomeEl.textContent = chunks.biomeAt(car.x, car.z) ?? ""
      clockEl.textContent = dayNight.clock()
      round.hud()
      if (loading.open) loading.progress(chunks.readyFraction(car.x, car.z), round.running ? null : Math.max(0, Math.ceil(((round.round?.next_at ?? 0) - round.now()) / 1000)))
      music.update(!!round.round && round.status !== "ended", parade.mesh.visible ? Math.hypot(parade.x - car.x, parade.z - car.z) : Infinity)
    }
    minimap.update(car, remotes, round)

    const shownKmh = Math.round(Math.hypot(car.vx, car.vz) * 3.6)
    if (shownKmh !== lastKmh) { lastKmh = shownKmh; kmh.textContent = shownKmh }
    cooldownBar.style.transform = `scaleX(${(1 - combat.cooldownFraction).toFixed(3)})`
    const meter = Math.round(car.boostMeter * 200) / 200
    if (meter !== lastMeter) { lastMeter = meter; boostFill.style.transform = `scaleX(${meter})` }
    const boostOn = car.boostPower > 0.3
    if (boostOn !== lastBoostOn) { lastBoostOn = boostOn; boostEl.classList.toggle("on", boostOn) }
    const driftShown = car.drifting && !car.driftMild
    if (driftShown !== shownDrift) { shownDrift = driftShown; driftEl.hidden = !driftShown }
    if (driftShown && car.chargeLevel !== shownLevel) {
      shownLevel = car.chargeLevel
      pipsEl.textContent = "●".repeat(shownLevel) + "○".repeat(3 - shownLevel)
      driftEl.classList.toggle("l3", shownLevel === 3)
    }
    playersEl.textContent = remotes.count ? `${remotes.count} andere ${remotes.count === 1 ? "chauffeur" : "chauffeurs"} online` : ""

    world.render()
    requestAnimationFrame(frame)
  }
  frame(performance.now())
}

main().catch((e) => { console.error(e); document.body.insertAdjacentHTML("beforeend", `<pre style="color:#900;padding:1em">${e.message}</pre>`) })
