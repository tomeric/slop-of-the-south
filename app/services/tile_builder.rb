# Assembles one 500 m tile (Geo::HeightGrid is autoloaded from lib/ by Rails 8)
# into the JSON the Three.js client consumes.
# All coordinates are converted to game units (x east, z south, y up).
class TileBuilder
  MAX_LEVELS = 12        # BAG has a handful of "43 storey" silos and chimneys; nothing real here is taller

  def initialize(heights: Geo::HeightGrid.current)
    @heights = heights
  end

  def build(tx, ty)
    s = World::TILE_SIZE
    x0, y0 = tx * s, ty * s
    meshes = meshes_for(tx, ty)
    network = RoadBuilder.new(@heights).build(tx, ty)   # smoothed, pinned road profiles + terrain deformation
    water = water_beds(tx, ty, x0, y0 + s)              # surface levels and carved beds of the bigger water bodies
    paved = RoadSurface.in_tile(tx, ty)                  # the surveyed road, footway and parking outlines
    cover, cover_sub = cover_for(tx, ty, x0, y0 + s, water[:levels], paved)
    {
      tx: tx, ty: ty,
      origin: World.to_game(x0, y0 + s),      # game-space corner (west, north)
      heights: heights_for(x0, y0, network[:deform], water[:bed]),
      roads: network[:roads],
      junctions: network[:junctions],
      buildings: buildings_for(tx, ty, skip: meshes.map { _1[:id] }.to_set),
      meshes: meshes,
      trees: trees_for(tx, ty),
      furniture: FurnitureBuilder.new.build(tx, ty),
      cover: cover,
      cover_sub: cover_sub,
      surfaces: surfaces_for(paved, x0, y0 + s),
      biome: LandCover.biome(LandCover.shares_in_tile(tx, ty))
    }
  end

  private

  # Flat array, HEIGHT_N × HEIGHT_N, rows north→south, columns west→east.
  # `deform` (from RoadBuilder) seats the terrain under and beside roads.
  # `bed` ({ [row, col] => height }) lowers samples inside water bodies to their carved bed.
  def heights_for(x0, y0, deform = nil, bed = {})
    n, step, s = World::HEIGHT_N, World::HEIGHT_STEP, World::TILE_SIZE
    out = Array.new(n * n)
    n.times do |row|
      y = y0 + s - row * step
      n.times do |col|
        x = x0 + col * step
        h = @heights.sample(x, y)
        h = deform.call(x, y, h) if deform
        b = bed[[ row, col ]]
        h = b if b && b < h
        out[row * n + col] = h.round(2)
      end
    end
    out
  end

  # Extruded boxes: OSM footprints and any 3D BAG parts whose building has no LoD2.2 mesh.
  def buildings_for(tx, ty, skip: Set.new)
    Building.in_tile(tx, ty).filter_map do |b|
      next if b["source"] == "bag3d" && skip.include?(b["source_id"].split("/").first.split(".").last)   # mesh ids are the numeric BAG id
      ring = b["geojson"]["coordinates"]&.first
      next if ring.nil? || ring.size < 4
      ring = ring[0...-1] # drop closing vertex
      base = ring.map { |x, y| @heights.sample(x, y) }.min
      # 3D BAG gives the absolute roof level (m NAP): extrude from the terrain up to it, so roofs sit at their true
      # height even where the DEM and the building ground level disagree a little. OSM only has a relative height.
      height = b["roof_height"] ? b["roof_height"].to_f - base : b["height"].to_f
      {
        id: b["id"],
        base: base.round(2),
        height: height.clamp(2.5, 200.0).round(2),
        kind: b["kind"],
        roof: b["roof_type"],
        footprint: ring.map { |x, y| World.to_game(x, y).map { _1.round(2) } }
      }.compact
    end
  end

  # 3D BAG LoD2.2 surfaces as faces the client triangulates: per building an origin (game units) and faces
  # [label, outer_ring, hole_ring, ...] with vertices as flat centimetre offsets [dx, dy, dz, ...] from the origin.
  # Ground faces are not drawn (the terrain covers them); their outlines go out as `fp`, the 2D footprint rings the
  # client collides with. A building whose ground level lies above the DEM is lowered onto the terrain so it
  # never floats.
  def meshes_for(tx, ty)
    BuildingMesh.in_tile(tx, ty).filter_map do |m|
      polys = m["geojson"]["coordinates"]
      next if polys.blank?
      labels = m["labels"].is_a?(String) ? m["labels"].scan(/\d+/).map(&:to_i) : m["labels"]
      ground = polys.flat_map { |rings| rings.first.map { _1[2] } }.min
      ground_rings = polys.each_with_index.filter_map { |rings, i| rings.first if labels[i] == BuildingMesh::LABEL_GROUND }
      footprint = ground_rings.flatten(1)
      footprint = polys.flat_map(&:first) if footprint.empty?
      base = footprint.map { |x, y, _| @heights.sample(x, y) }.min
      dz = [ base - ground, 0.0 ].min
      ox, oz = World.to_game(*polys.first.first.first[0, 2]).map { _1.round(2) }
      oy = (ground + dz).round(2)
      faces = polys.each_with_index.filter_map do |rings, i|
        next if labels[i] == BuildingMesh::LABEL_GROUND
        [ labels[i] || BuildingMesh::LABEL_WALL, *rings.map { |ring| ring_offsets(ring, ox, oy, oz, dz) } ]
      end
      next if faces.empty?
      # n: the storeys BAG counted (b3_bouwlagen). The client falls back to round(wall height / 3) without it, which
      # is what every tile built before this held; clamped here so a silo does not claim forty floors.
      { id: m["bag_id"].split(".").last, roof: m["roof_type"], o: [ ox, oy, oz ], f: faces,
        n: m["levels"]&.clamp(1, MAX_LEVELS),
        fp: (ground_rings.map { ring_xz(_1) } if ground_rings.any?) }.compact
    end
  end

  # ring of RD [x, y, z] → flat [x, z, ...] in game units (closing vertex dropped)
  def ring_xz(ring)
    pts = ring.first == ring.last ? ring[0...-1] : ring
    pts.flat_map { |x, y, _| World.to_game(x, y).map { _1.round(2) } }
  end

  # ring of RD [x, y, z] → flat centimetre offsets from the origin (closing vertex dropped)
  def ring_offsets(ring, ox, oy, oz, dz)
    pts = ring.first == ring.last ? ring[0...-1] : ring
    pts.flat_map do |x, y, z|
      gx, gz = World.to_game(x, y)
      [ ((gx - ox) * 100).round, ((z + dz - oy) * 100).round, ((gz - oz) * 100).round ]
    end
  end

  # Trees as [x, z, kind, height] in game units (kind 0 street tree, 1 deciduous wood, 2 conifer); the client
  # samples the terrain for y.
  def trees_for(tx, ty)
    Tree.in_tile(tx, ty).map do |x, y, kind, h|
      gx, gz = World.to_game(x, y)
      [ gx.round(1), gz.round(1), kind, h.round(1) ]
    end
  end

  # Land cover polygons clipped to the tile: [code, outer_ring, hole_ring, ...] with rings as flat decimetre
  # offsets [dx, dz, ...] from the tile origin (west, north), so 0..5000 across the tile. Painted onto the terrain.
  # Water entries carry their surface level (metres NAP, or null for water draped on the terrain) before the rings:
  # [30, level, outer_ring, hole_ring, ...]. Returns `cover_sub` alongside it: one BGT sub-kind code per entry
  # (LandCover::DETAILS, 0 where the source records none), which the client uses to pick a finer pattern.
  def cover_for(tx, ty, x0, y1, levels = {}, paved = [])
    cover, sub = [], []
    verges = paved.filter_map { |cls, _mat, polys| [ LandCover::VERGE, polys, nil, 0 ] if cls == RoadSurface::VERGE }
    entries = LandCover.in_tile(tx, ty) + verges
    entries.sort_by { |code, _| [ LandCover::ORDER.call(code), code ] }.each do |code, polys, water, detail|
      polys.each do |rings|
        rings = rings.map { |ring| ring_dm(ring, x0, y1) }.reject { _1.size < 6 }
        next if rings.empty?
        cover << (water ? [ code, levels[water[:id]]&.round(2), *rings ] : [ code, *rings ])
        sub << detail.to_i
      end
    end
    [ cover, sub ]
  end

  # The road surfaces the client draws on the ground: [class, material, outer_ring, hole_ring, ...] with rings as
  # flat decimetre offsets from the tile origin, like `cover`. The green verges are not here — they are painted
  # with the land cover instead (cover_for).
  def surfaces_for(paved, x0, y1)
    paved.flat_map do |cls, mat, polys|
      next [] unless RoadSurface::DRAWN.include?(cls)
      polys.filter_map do |rings|
        rings = rings.map { |ring| ring_dm(ring, x0, y1) }.reject { _1.size < 6 }
        [ cls, mat, *rings ] unless rings.empty?
      end
    end
  end

  # The AHN height inside water is the water surface, so lakes, rivers and canals get a bed carved below it:
  # depth grows with the distance from the shore (LandCover::BANK_SLOPE) up to the kind's depth. Each flat water body's
  # level is the median terrain height of the grid samples inside it (or the height at a point on it when none fall in).
  # Returns { bed: { [row, col] => bed height }, levels: { land_cover id => level } }.
  def water_beds(tx, ty, x0, y1)
    n, step = World::HEIGHT_N, World::HEIGHT_STEP
    env = Road.tile_envelope_sql(tx, ty)
    rows = ActiveRecord::Base.connection.select_rows(<<~SQL)
      WITH w AS (
        SELECT id, kind, geom, ST_Boundary(geom) AS b, ST_X(ST_PointOnSurface(geom)) AS px, ST_Y(ST_PointOnSurface(geom)) AS py
        FROM land_covers WHERE #{LandCover::FLAT_WATER_SQL} AND geom && #{env} AND ST_Intersects(geom, #{env})
      ),
      pts AS (
        SELECT r AS row, c AS col, ST_SetSRID(ST_MakePoint(#{x0} + c * #{step}, #{y1} - r * #{step}), 28992) AS p
        FROM generate_series(0, #{n - 1}) AS r, generate_series(0, #{n - 1}) AS c
      )
      SELECT w.id, w.kind, w.px, w.py, pts.row, pts.col, ST_Distance(pts.p, w.b)
      FROM w LEFT JOIN pts ON ST_Intersects(w.geom, pts.p)
    SQL
    return { bed: {}, levels: {} } if rows.empty?
    by_water = rows.group_by(&:first)
    levels, bed = {}, {}
    by_water.each do |id, list|
      kind, px, py = list.first[1], list.first[2].to_f, list.first[3].to_f
      inside = list.select { _1[4] }
      samples = inside.map { |_, _, _, _, row, col| @heights.sample(x0 + col.to_i * step, y1 - row.to_i * step) }.sort
      level = samples.empty? ? @heights.sample(px, py) : samples[samples.size / 2]
      levels[id] = level
      max_depth = LandCover::DEPTH.fetch(kind, 3.0)
      inside.each do |_, _, _, _, row, col, dist|
        depth = [ dist.to_f * LandCover::BANK_SLOPE, max_depth ].min
        key = [ row.to_i, col.to_i ]
        bed[key] = [ bed[key], level - depth ].compact.min
      end
    end
    { bed: bed, levels: levels }
  end

  def ring_dm(ring, x0, y1)
    pts = ring.first == ring.last ? ring[0...-1] : ring
    pts.flat_map { |x, y| [ ((x - x0) * 10).round, ((y1 - y) * 10).round ] }
  end

  def lines_from(geojson)
    case geojson["type"]
    when "LineString"      then [ geojson["coordinates"] ]
    when "MultiLineString" then geojson["coordinates"]
    when "GeometryCollection" then geojson["geometries"].flat_map { lines_from(_1) }
    else []
    end
  end
end
