module Game
  # Picks a round's arena and asks PostGIS everything about it: a random settlement inside the border, a straight
  # parade route through it, the objects standing in the float's corridor with the distance at which its nose
  # reaches them, and a road near the start to drop the players on. Everything comes back in game units, with what
  # Wikipedia knows about the town for the loading screen.
  class Arena
    HALF      = 1250.0                             # arena half-size in metres
    CORRIDOR  = 3.0                                # half-width of the swept route: half the float plus a metre of margin
    NOSE      = Round::FLOAT[:length] / 2.0
    KINDS     = %w[city town village].freeze
    OBSTACLES = 15..250                            # retry the pick when a corridor is empty or hopeless
    FIRST_AT  = 120.0                              # metres of clear route the float gets before its first obstacle

    # A round's arena: the given town (the vote's winner) or a random one, with the first route through it that
    # holds a playable number of obstacles, else the last one tried. Every route gets its runway. The executor's
    # query cache would hand back the same random town for the life of the process; go around it.
    def prepare(place: nil, tries: 5)
      ActiveRecord::Base.uncached do
        best = nil
        tries.times do
          town = place || pick_place or break
          path, obstacles = route_with_runway(town)
          best = { arena: town.merge(half: HALF, info: TownInfo.fetch(town[:name], town[:kind])), path:, obstacles:, spawn: spawn_near(path) }
          return best if OBSTACLES.cover?(obstacles.size) && (obstacles.empty? || obstacles.first[:at] >= FIRST_AT)
        end
        best
      end
    end

    # a route through the town at a random heading, its start pulled back along the line until the float has
    # FIRST_AT metres of clear road before whatever stands first; the stretch added is checked for obstacles too
    def route_with_runway(town)
      path = path_for(town[:cx], town[:cz], rand * Math::PI)
      obstacles = obstacles(path)
      3.times do
        first = obstacles.first
        break unless first && first[:at] < FIRST_AT
        path = extend_start(path, FIRST_AT - first[:at] + 20)
        obstacles = obstacles(path)
      end
      [ path, obstacles ]
    end

    # the same line, started `by` metres earlier
    def extend_start(path, by)
      dx, dz = path[:x1] - path[:x0], path[:z1] - path[:z0]
      len = Math.hypot(dx, dz)
      { x0: (path[:x0] - dx / len * by).round(1), z0: (path[:z0] - dz / len * by).round(1), x1: path[:x1], z1: path[:z1], length: (len + by).round(1) }
    end

    # a random town whose whole arena lies inside the province
    def pick_place = candidates(1).first

    # n random towns to vote on
    def candidates(n)
      ActiveRecord::Base.uncached { places("ORDER BY random() LIMIT #{n.to_i}") }
    end

    # the town a player typed: an exact name first, then the shortest name starting with it
    def find_place(name)
      q = conn.quote(name.strip)
      places("AND lower(p.name) = lower(#{q}) LIMIT 1").first || places("AND p.name ILIKE #{conn.quote(name.strip + '%')} ORDER BY length(p.name) LIMIT 1").first
    end

    # towns whose whole arena lies inside the province, in game units
    def places(tail)
      conn.select_rows(<<~SQL).map do |name, kind, x, y|
        SELECT p.name, p.kind, ST_X(p.geom), ST_Y(p.geom)
        FROM places p JOIN boundaries b ON b.name = 'Limburg'
        WHERE p.kind IN (#{KINDS.map { conn.quote(_1) }.join(",")}) AND ST_Contains(b.geom, ST_Expand(p.geom, #{HALF + 250}))
        #{tail}
      SQL
        cx, cz = World.to_game(x.to_f, y.to_f)
        { name:, kind:, cx: cx.round(1), cz: cz.round(1) }
      end
    end

    # a straight route through the centre at `heading` (compass radians), ending on the arena square
    def path_for(cx, cz, heading, half = HALF)
      dx, dz = Math.sin(heading), -Math.cos(heading)
      r = half / [ dx.abs, dz.abs ].max
      { x0: (cx - dx * r).round(1), z0: (cz - dz * r).round(1), x1: (cx + dx * r).round(1), z1: (cz + dz * r).round(1), length: (2 * r).round(1) }
    end

    # everything standing in the corridor, one entry per key, sorted by the distance at which the nose reaches it
    def obstacles(path)
      with = corridor_sql(path)
      (buildings(with, path[:length]) + points(with, path[:length]))
        .group_by { _1[:key] }.map { |_, same| same.min_by { _1[:at] } }.sort_by { _1[:at] }
    end

    # the nearest drivable road to a point 40 m down the path, facing along it; the path start itself otherwise
    def spawn_near(path)
      dx, dz = path[:x1] - path[:x0], path[:z1] - path[:z0]
      len = Math.hypot(dx, dz)
      dx, dz = dx / len, dz / len
      heading = Math.atan2(dx, -dz)                                             # compass radians of the path
      sx, sy = World.to_rd(path[:x0] + dx * 40, path[:z0] + dz * 40)
      row = conn.select_rows(<<~SQL).first
        SELECT ST_X(t.cp), ST_Y(t.cp),
               ST_Azimuth(ST_LineInterpolatePoint(t.geom, GREATEST(t.f - 0.01, 0)), ST_LineInterpolatePoint(t.geom, LEAST(t.f + 0.01, 1)))
        FROM (SELECT r.geom, ST_ClosestPoint(r.geom, s.pt) AS cp, ST_LineLocatePoint(r.geom, s.pt) AS f
              FROM roads r, (SELECT ST_SetSRID(ST_MakePoint(#{sx}, #{sy}), 28992) AS pt) s
              WHERE r.highway NOT IN ('cycleway', 'track') AND ST_DWithin(r.geom, s.pt, 400)
              ORDER BY r.geom <-> s.pt LIMIT 1) t
      SQL
      return { x: path[:x0], z: path[:z0], yaw: yaw(heading) } unless row&.last
      x, y, az = row
      gx, gz = World.to_game(x.to_f, y.to_f)
      az = az.to_f
      az += Math::PI if Math.cos(az - heading) < 0                              # face along the path, not against it
      { x: gx.round(1), z: gz.round(1), yaw: yaw(az) }
    end

    # compass radians → Vehicle.js yaw (0 north, positive turns left) in (-π, π]
    def yaw(compass) = (((Math::PI - compass) % (2 * Math::PI)) - Math::PI).round(3)

    private

    def conn = ActiveRecord::Base.connection

    def corridor_sql(path)
      ax, ay = World.to_rd(path[:x0], path[:z0])
      bx, by = World.to_rd(path[:x1], path[:z1])
      <<~SQL
        WITH c AS (SELECT line, ST_Buffer(line, #{CORRIDOR}, 'endcap=flat') AS corr
                   FROM (SELECT ST_SetSRID(ST_MakeLine(ST_MakePoint(#{ax}, #{ay}), ST_MakePoint(#{bx}, #{by})), 28992) AS line) l)
      SQL
    end

    # buildings meeting the corridor, with the bag3d-wins rule of Building.in_tile; parts with a LoD2.2 mesh take
    # the mesh key. `at` is the corridor vertex of the footprint the line reaches first.
    def buildings(with, length)
      conn.select_rows(<<~SQL).map do |id, has_mesh, bag, x, y, frac|
        #{with}
        SELECT b.id,
               EXISTS (SELECT 1 FROM building_meshes m WHERE m.bag_id = split_part(b.source_id, '/', 1)),
               split_part(b.source_id, '/', 1),
               ST_X(ST_Centroid(b.geom)), ST_Y(ST_Centroid(b.geom)),
               COALESCE((SELECT min(ST_LineLocatePoint(c.line, d.geom)) FROM ST_DumpPoints(ST_Intersection(b.geom, c.corr)) d),
                        ST_LineLocatePoint(c.line, ST_ClosestPoint(b.geom, c.line)))
        FROM buildings b, c
        WHERE b.geom && c.corr AND ST_Intersects(b.geom, c.corr)
          AND (b.source <> 'osm' OR NOT EXISTS (
                SELECT 1 FROM buildings o WHERE o.source = 'bag3d' AND o.geom && b.geom AND ST_Intersects(o.geom, b.geom)))
      SQL
        gx, gz = World.to_game(x.to_f, y.to_f)
        key = has_mesh ? "m:#{bag.split(".").last}" : "b:#{id}"
        { key:, kind: key[0], x: gx.round(1), z: gz.round(1), at: (frac.to_f * length - NOSE).round(1) }
      end
    end

    # trees, lamp posts, traffic lights and signs within the corridor, filtered like the tile builders emit them
    def points(with, length)
      conn.select_rows(<<~SQL).map do |prefix, x, y, frac|
        #{with}
        SELECT 't', ST_X(t.geom), ST_Y(t.geom), ST_LineLocatePoint(c.line, t.geom)
        FROM trees t, c WHERE t.geom && c.corr AND ST_DWithin(t.geom, c.line, #{CORRIDOR})
        UNION ALL
        SELECT CASE p.kind WHEN 'lamp' THEN 'l' ELSE 'g' END, ST_X(p.geom), ST_Y(p.geom), ST_LineLocatePoint(c.line, p.geom)
        FROM poles p, c WHERE p.kind IN ('lamp', 'signal') AND p.geom && c.corr AND ST_DWithin(p.geom, c.line, #{CORRIDOR})
          AND (p.kind = 'lamp' OR EXISTS (SELECT 1 FROM roads r WHERE r.highway NOT IN ('cycleway', 'track') AND ST_DWithin(r.geom, p.geom, 20)))
        UNION ALL
        SELECT 's', ST_X(s.geom), ST_Y(s.geom), ST_LineLocatePoint(c.line, s.geom)
        FROM traffic_signs s, c
        WHERE s.status = 'PLACED' AND s.rvv_code <> 'onbekend' AND s.geom && c.corr AND ST_DWithin(s.geom, c.line, #{CORRIDOR})
      SQL
        gx, gz = World.to_game(x.to_f, y.to_f)
        { key: Game.point_key(prefix, gx, gz), kind: prefix, x: gx.round(1), z: gz.round(1), at: (frac.to_f * length - NOSE).round(1) }
      end
    end
  end
end
