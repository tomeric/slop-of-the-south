# Procedural road geometry for one tile.
#
# Roads are OSM centrelines. For each road within the tile (plus a margin) the terrain is sampled along the way,
# smoothed, pinned at junction nodes (so meeting roads share a height), and clamped so it stays within a small cut
# below / a limited fill above the terrain; bridges keep their smoothed line and float. Ribbons are cut back where
# three or more roads meet and a plain junction patch covers the crossing, so lane markings stop short of it. Finally
# the terrain samples of the tile are deformed: the road bed is the road surface level, a verge band beside it sits a
# curb higher, and the terrain blends back to nature over the shoulder. The height on the wire IS the road surface;
# the client lifts its ribbons by a few cm only to avoid z-fighting.
class RoadBuilder
  MARGIN = 250          # metres beyond the tile: roads and junctions here influence the tile's roads and terrain
  STEP = 8.0            # resampling distance along a road
  WINDOW = { major: 60.0, minor: 30.0 }.freeze   # box-filter window for the height profile (majors get it twice)
  CURB = 0.12           # verge / sidewalk level above the road surface
  VERGE = 2.5           # metres beside the bed held at road + CURB (the sidewalk strip)
  SHOULDER = 6.0        # metres beyond the verge over which the terrain blends back to nature
  CUT_LIMIT = 0.25      # a road may sink at most this far below the terrain (buildings use the raw DEM)
  FILL_LIMIT = { major: 6.0, minor: 1.5, path: 0.4 }.freeze   # …and rise at most this far above it, bridges excepted
  MAJOR = %w[motorway motorway_link trunk trunk_link primary primary_link].freeze
  PATHS = %w[cycleway track].freeze
  KINDS_WITHOUT_TERRAIN_WORK = PATHS   # narrow paths do not terrace the fields; their ribbons follow the terrain client-side
  COVERED = 0.5         # a road BGT paves less of than this keeps its own ribbon on the client

  RoadRow = Struct.new(:id, :kind, :name, :width, :lanes, :surface, :oneway, :bridge, :tunnel, :pts)   # pts: [[x, y], …] RD

  def initialize(heights)
    @heights = heights
  end

  # Returns { roads: [...], junctions: [...], deform: lambda } for the tile.
  def build(tx, ty)
    s = World::TILE_SIZE
    x0, y0, x1, y1 = tx * s, ty * s, (tx + 1) * s, (ty + 1) * s
    rows = fetch(x0 - MARGIN, y0 - MARGIN, x1 + MARGIN, y1 + MARGIN)
    paved = RoadSurface.paved_fraction(x0 - MARGIN, y0 - MARGIN, x1 + MARGIN, y1 + MARGIN)
    crossings = water_crossings(x0 - MARGIN, y0 - MARGIN, x1 + MARGIN, y1 + MARGIN)
    profiles = rows.reject(&:tunnel).map { |r| [ r, profile(r) ] }
    nodes = junction_nodes(profiles)
    profiles.each { |road, prof| bridges!(road, prof, crossings[road.id]) }   # before pinning: bridge samples escape the clamp
    pin!(profiles, nodes)
    profiles.each_with_index { |(_, prof), ri| decks!(ri, prof, profiles, nodes) }
    pieces = profiles.flat_map { |road, prof| cut_at_junctions(road, prof, nodes) }
    {
      roads: pieces.filter_map { |road, pts| clip(road, pts, x0, y0, x1, y1, paved) },
      junctions: nodes.values.select { |n| n[:degree] >= 3 && n[:x].between?(x0, x1) && n[:y].between?(y0, y1) }
                      .map { |n| gx, gz = World.to_game(n[:x], n[:y]); [ gx.round(2), gz.round(2), n[:h].round(2), n[:r].round(2) ] },
      deform: deformer(pieces, nodes)
    }
  end

  private

  def klass(road)
    return :major if MAJOR.include?(road.kind)
    return :path if PATHS.include?(road.kind)
    :minor
  end

  def fetch(x0, y0, x1, y1)
    env = "ST_MakeEnvelope(#{x0}, #{y0}, #{x1}, #{y1}, 28992)"
    rows = ActiveRecord::Base.connection.select_rows(<<~SQL)
      SELECT id, highway, name, width, lanes, surface, oneway, bridge, tunnel, ST_AsGeoJSON(geom, 2)
      FROM roads WHERE geom && #{env}
    SQL
    rows.map do |id, kind, name, width, lanes, surface, oneway, bridge, tunnel, geojson|
      RoadRow.new(id, kind, name, width.to_f, lanes, surface, oneway, bridge, tunnel, JSON.parse(geojson)["coordinates"])
    end
  end

  # [[x, y, terrain_h, smooth_h, pinned?], …] resampled every STEP metres, original vertices kept
  def profile(road)
    pts = []
    road.pts.each_cons(2) do |(ax, ay), (bx, by)|
      len = Math.hypot(bx - ax, by - ay)
      n = [ (len / STEP).ceil, 1 ].max
      n.times { |k| pts << [ ax + (bx - ax) * k / n, ay + (by - ay) * k / n ] }
    end
    pts << road.pts.last
    terrain = pts.map { |x, y| @heights.sample(x, y) }
    smooth = klass(road) == :major ? box_filter(box_filter(terrain, WINDOW[:major]), WINDOW[:major]) : box_filter(terrain, WINDOW[:minor])
    pts.each_with_index.map { |(x, y), i| [ x, y, terrain[i], smooth[i], false ] }
  end

  def box_filter(values, window)
    half = (window / STEP / 2).ceil
    values.each_index.map do |i|
      lo, hi = [ i - half, 0 ].max, [ i + half, values.size - 1 ].min
      values[lo..hi].sum / (hi - lo + 1)
    end
  end

  # nodes shared by two or more roads (by coordinate, cm precision): height = mean of the roads' profiles, kept within
  # the cut/fill limits of the most terrain-bound road there so every ribbon can meet the junction patch
  def junction_nodes(profiles)
    hits = Hash.new { |h, k| h[k] = [] }
    profiles.each_with_index do |(road, prof), ri|
      road.pts.each { |x, y| hits[[ (x * 100).round, (y * 100).round ]] << [ ri, x, y ] }
    end
    hits.each_with_object({}) do |(key, list), nodes|
      roads_here = list.map(&:first).uniq
      next if roads_here.size < 2
      x, y = list.first[1], list.first[2]
      heights = list.map { |ri, _, _| p = profiles[ri][1].find { |px, py, _, _, _| (px - x).abs < 0.005 && (py - y).abs < 0.005 }; p && p[3] }.compact
      widths = roads_here.map { |ri| profiles[ri][0].width }
      terrain = @heights.sample(x, y)
      fill = roads_here.map { |ri| FILL_LIMIT[klass(profiles[ri][0])] }.min
      h = heights.empty? ? terrain : heights.sum / heights.size
      h = h.clamp(terrain - CUT_LIMIT, terrain + fill) unless roads_here.all? { |ri| profiles[ri][0].bridge }
      nodes[key] = { x: x, y: y, degree: list.size, h: h, r: widths.max * 0.5 + 1.0, roads: roads_here }
    end
  end

  BRIDGE_GAP = 4.0      # smoothed road this far above the terrain becomes a bridge instead of an embankment
  BRIDGE_RUN = 3        # …for at least this many samples (24 m)
  DECK_GRADE = 0.03     # bridge decks climb from both abutments at this grade…
  DECK_RISE = 1.2       # …until they are this far above the straight line between the abutments

  # parts of each road (by id) that lie over water: [[x, y], …] linestrings in RD
  def water_crossings(x0, y0, x1, y1)
    env = "ST_MakeEnvelope(#{x0}, #{y0}, #{x1}, #{y1}, 28992)"
    rows = ActiveRecord::Base.connection.select_rows(<<~SQL)
      WITH w AS (SELECT ST_Union(geom) AS geom FROM land_covers WHERE layer = 'water' AND geom && #{env})
      SELECT r.id, ST_AsGeoJSON(ST_CollectionExtract(ST_Intersection(r.geom, w.geom), 2), 2)
      FROM roads r, w WHERE r.geom && #{env} AND w.geom IS NOT NULL AND ST_Intersects(r.geom, w.geom)
    SQL
    rows.to_h do |id, geojson|
      g = geojson ? JSON.parse(geojson) : nil
      lines = case g&.dig("type")
      when "LineString" then [ g["coordinates"] ]
      when "MultiLineString" then g["coordinates"]
      else []
      end
      [ id, lines ]
    end
  end

  # Mark bridge samples: tagged bridges entirely; otherwise samples over water (with one sample of approach each
  # side) and runs where the smoothed road floats BRIDGE_GAP above the terrain.
  def bridges!(road, prof, crossings)
    prof.each { |p| p[5] = false }
    if road.bridge
      prof.each { |p| p[5] = true }
    else
      (crossings || []).each do |line|
        prof.each { |p| p[5] = true if near_line?(p[0], p[1], line, 1.0) }
      end
      prof.each_with_index { |p, i| p[5] = true if !p[5] && (i > 0 && prof[i - 1][5] || i < prof.size - 1 && prof[i + 1][5]) && prof[i][3] - prof[i][2] > 1.0 }
      i = 0
      while i < prof.size
        if prof[i][3] - prof[i][2] > BRIDGE_GAP
          j = i
          j += 1 while j < prof.size && prof[j][3] - prof[j][2] > BRIDGE_GAP
          (i...j).each { |k| prof[k][5] = true } if j - i >= BRIDGE_RUN
          i = j
        else
          i += 1
        end
      end
    end
  end

  # Each bridge run gets a deck that climbs at DECK_GRADE from both abutments onto a level DECK_RISE above the
  # straight line between them, so it never sags and always tops the roads leading onto it. A run that reaches the
  # end of its way and carries on over the neighbouring way counts that bridge too, so a bridge cut into several
  # ways ramps up once at each real abutment instead of at every seam.
  def decks!(ri, prof, profiles, nodes)
    i = 0
    while i < prof.size
      if prof[i][5]
        j = i
        j += 1 while j < prof.size && prof[j][5]
        a = [ i - 1, 0 ].max
        b = [ j, prof.size - 1 ].min
        ha, hb = prof[a][3], prof[b][3]
        dist = ->(k) { (a...k).sum { |m| Math.hypot(prof[m + 1][0] - prof[m][0], prof[m + 1][1] - prof[m][1]) } }
        total = dist.call(b)
        before = i.zero? ? bridge_beyond(ri, prof.first, profiles, nodes) : 0.0
        after = j == prof.size ? bridge_beyond(ri, prof.last, profiles, nodes) : 0.0
        (i...j).each do |k|
          d = dist.call(k)
          prof[k][3] = total.zero? ? ha : ha + (hb - ha) * d / total + [ DECK_RISE, DECK_GRADE * [ d + before, total - d + after ].min ].min
        end if b > a
        i = j
      else
        i += 1
      end
    end
  end

  # metres of bridge continuing past `p`, the end of way `ri`, through the one way that starts or ends there
  def bridge_beyond(ri, p, profiles, nodes, seen = [])
    key = ->(q) { [ (q[0] * 100).round, (q[1] * 100).round ] }
    node = nodes[key.call(p)]
    return 0.0 unless node && node[:roads].size == 2
    oi = (node[:roads] - [ ri ] - seen).first
    return 0.0 unless oi
    prof = profiles[oi][1]
    prof = prof.reverse unless key.call(prof.first) == key.call(p)
    return 0.0 unless key.call(prof.first) == key.call(p) && prof.first[5]
    run = prof.take_while { |q| q[5] }
    length = run.each_cons(2).sum { |q, r| Math.hypot(r[0] - q[0], r[1] - q[1]) }
    run.size == prof.size ? length + bridge_beyond(oi, prof.last, profiles, nodes, seen + [ ri ]) : length
  end

  def near_line?(x, y, line, tol)
    line.each_cons(2).any? do |(ax, ay), (bx, by)|
      dx, dy = bx - ax, by - ay
      len2 = dx * dx + dy * dy
      t = len2.zero? ? 0.0 : (((x - ax) * dx + (y - ay) * dy) / len2).clamp(0.0, 1.0)
      Math.hypot(ax + dx * t - x, ay + dy * t - y) <= tol
    end
  end

  # correct each profile so junction vertices hit the node height, blending the correction between pins and
  # fading it out 100 m past the outer pins; then keep the road within CUT_LIMIT below / FILL_LIMIT above the
  # terrain (bridge samples excepted). Node heights already satisfy the clamp, so pinned vertices stay shared.
  def pin!(profiles, nodes)
    profiles.each do |road, prof|
      fill = FILL_LIMIT[klass(road)]
      pins = prof.each_index.select { |i| nodes.key?([ (prof[i][0] * 100).round, (prof[i][1] * 100).round ]) }
      deltas = pins.to_h { |i| [ i, nodes[[ (prof[i][0] * 100).round, (prof[i][1] * 100).round ]][:h] - prof[i][3] ] }
      pins.each { |i| prof[i][4] = true }
      prof.each_index do |i|
        c = correction(i, pins, deltas)
        h = prof[i][3] + c
        h = h.clamp(prof[i][2] - CUT_LIMIT, prof[i][2] + fill) unless road.bridge || prof[i][5]
        prof[i][3] = h
      end
    end
  end

  def correction(i, pins, deltas)
    return 0.0 if pins.empty?
    return deltas[i] if deltas.key?(i)
    before = pins.select { _1 < i }.max
    after = pins.select { _1 > i }.min
    fade = ->(pin) { deltas[pin] * [ 0.0, 1.0 - (i - pin).abs * STEP / 100.0 ].max }
    return fade.call(after) unless before
    return fade.call(before) unless after
    t = (i - before).to_f / (after - before)
    deltas[before] * (1 - t) + deltas[after] * t
  end

  # split a road at junction nodes of degree >= 3 and cut each side back by the node radius
  def cut_at_junctions(road, prof, nodes)
    junction = ->(p) { n = nodes[[ (p[0] * 100).round, (p[1] * 100).round ]]; n && n[:degree] >= 3 ? n : nil }
    pieces, current = [], []
    prof.each_with_index do |p, i|
      if (n = junction.call(p)) && i.positive? && i < prof.size - 1
        pieces << [ road, trim(current + [ p ], nil, n) ]
        current = [ p ]
        current_start = n
        pieces.last << current_start   # marker unused
      else
        current << p
      end
    end
    pieces << [ road, current ]
    # trim ends against junction nodes
    pieces.filter_map do |rd, pts, _|
      pts = trim(pts, junction.call(pts.first), junction.call(pts.last)) if pts.size >= 2
      next if pts.nil? || pts.size < 2
      [ rd, pts.map { |x, y, _, h, _, b| [ x, y, h, b ? 1 : 0 ] } ]
    end
  end

  # shorten a polyline by r at each end that is a junction (nil = leave that end alone)
  def trim(pts, start_node, end_node)
    pts = shorten(pts, start_node[:r]) if start_node
    pts = shorten(pts.reverse, end_node[:r]).reverse if end_node && pts.size >= 2
    pts
  end

  def shorten(pts, r)
    return pts if pts.size < 2
    remaining = r
    while pts.size >= 2
      a, b = pts[0], pts[1]
      d = Math.hypot(b[0] - a[0], b[1] - a[1])
      if d > remaining
        t = remaining / d
        return [ [ a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 0, a[3] + (b[3] - a[3]) * t, false, a[5] ] ] + pts[1..]
      end
      remaining -= d
      pts = pts[1..]
    end
    pts
  end

  # clip a 3D polyline (RD x, y, h) to the tile envelope; returns the tile road entry or nil
  def clip(road, pts, x0, y0, x1, y1, paved = {})
    inside = ->(p) { p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1 }
    out = []
    pts.each_cons(2) do |a, b|
      seg = clip_segment(a, b, x0, y0, x1, y1)
      next unless seg
      out << seg[0] if out.empty? || (out.last[0] - seg[0][0]).abs > 1e-6 || (out.last[1] - seg[0][1]).abs > 1e-6
      out << seg[1]
    end
    return nil if out.size < 2 || !pts.any?(&inside) && out.size < 2
    game = out.map { |x, y, h, b| gx, gz = World.to_game(x, y); [ gx.round(2), gz.round(2), h.round(2), b ] }
    ribbon = 1 if paved.fetch(road.id, 0.0) < COVERED            # BGT has no outline here: draw our own ribbon
    { kind: road.kind, name: road.name, width: road.width, lanes: road.lanes, surface: road.surface, oneway: road.oneway, ribbon: ribbon, pts: game }.compact
  end

  # Liang–Barsky, interpolating the height
  def clip_segment(a, b, x0, y0, x1, y1)
    dx, dy = b[0] - a[0], b[1] - a[1]
    t0, t1 = 0.0, 1.0
    [ [ -dx, a[0] - x0 ], [ dx, x1 - a[0] ], [ -dy, a[1] - y0 ], [ dy, y1 - a[1] ] ].each do |p, q|
      if p.zero?
        return nil if q < 0
      else
        t = q / p
        if p < 0 then t0 = [ t0, t ].max else t1 = [ t1, t ].min end
      end
    end
    return nil if t0 > t1
    lerp = ->(t) { [ a[0] + dx * t, a[1] + dy * t, a[2] + (b[2] - a[2]) * t, (t < 0.5 ? a[3] : b[3]) ] }
    [ lerp.call(t0), lerp.call(t1) ]
  end

  # returns a lambda (x, y, terrain_h) → deformed height: under and beside roads the terrain becomes the road bed
  # (at the road surface level), then a verge a curb higher, then blends back to nature over the shoulder.
  # The bed half-width is at least half a height step so every road gets at least one bed sample per side — a 10 m
  # grid cannot follow a 3 m cut, and a ribbon whose bracketing samples are both on the verge would be buried.
  # Junction nodes get their own seat: the pieces were cut back by the node radius, so without it the patch would
  # end up on the verge.
  def deformer(pieces, nodes)
    segments = []
    pieces.each do |road, pts|
      next if KINDS_WITHOUT_TERRAIN_WORK.include?(road.kind)
      hw = [ road.width / 2 + 0.5, World::HEIGHT_STEP / 2.0 ].max
      pts.each_cons(2) { |a, b| segments << [ a, b, hw ] unless a[3] == 1 && b[3] == 1 }   # bridge decks don't touch the ground
    end
    nodes.each_value do |n|
      next unless n[:degree] >= 3
      p = [ n[:x], n[:y], n[:h] ]
      segments << [ p, p, [ n[:r] + 0.5, World::HEIGHT_STEP / 2.0 ].max ]
    end
    grid = Hash.new { |h, k| h[k] = [] }
    cell = 50.0
    pad = segments.map { _1[2] }.max.to_f + VERGE + SHOULDER + 1
    segments.each do |seg|
      xs = [ seg[0][0], seg[1][0] ]; ys = [ seg[0][1], seg[1][1] ]
      ((xs.min - pad) / cell).floor.upto(((xs.max + pad) / cell).floor) do |cx|
        ((ys.min - pad) / cell).floor.upto(((ys.max + pad) / cell).floor) { |cy| grid[[ cx, cy ]] << seg }
      end
    end
    lambda do |x, y, h|
      best_d, best_h = Float::INFINITY, nil
      grid[[ (x / cell).floor, (y / cell).floor ]].each do |a, b, hw|
        dx, dy = b[0] - a[0], b[1] - a[1]
        len2 = dx * dx + dy * dy
        t = len2.zero? ? 0.0 : (((x - a[0]) * dx + (y - a[1]) * dy) / len2).clamp(0.0, 1.0)
        px, py = a[0] + dx * t, a[1] + dy * t
        d = Math.hypot(px - x, py - y) - hw           # distance outside the bed (negative inside)
        next unless d < best_d
        best_d, best_h = d, a[2] + (b[2] - a[2]) * t
      end
      return h unless best_h
      bed = best_h
      return bed if best_d <= 0
      verge = bed + CURB
      return verge if best_d <= VERGE
      blend = (best_d - VERGE) / SHOULDER
      blend >= 1 ? h : verge + (h - verge) * blend
    end
  end
end
