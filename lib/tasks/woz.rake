require "net/http"

# What every building in the province is worth, so that flattening one can cost a number.
#
# CBS publishes the average WOZ assessment of a house per neighbourhood (`gemiddeldeWoningwaarde`, thousands of
# euros) together with the number of dwellings there, through the PDOK wijken-en-buurten WFS. Multiply the two and
# you have what the housing in that buurt is worth; divide it by the floor area our own BAG buildings add up to
# inside the same buurt and you have a price per square metre; give each building its own floor area at that rate
# and the sum comes back out at what CBS said. A shed gets shed money and a block of flats gets the forty dwellings
# it holds, without anybody having to know what any individual house sold for.
namespace :woz do
  WIJKEN_BUURTEN = ENV.fetch("WIJKEN_BUURTEN_URL", "https://service.pdok.nl/cbs/wijkenbuurten/2023/wfs/v1_0")
  HOUSE_MIN, HOUSE_MAX = 40, 1000       # m² of floor: what counts as a house when averaging a neighbourhood
  HALL = 400                            # m² of footprint: bigger than this without a storey count is a hall, one floor
  CAP = 50_000_000                      # €: nothing is worth more than this, whatever the arithmetic says

  desc "Fetch CBS neighbourhoods with their average house value into the neighbourhoods table"
  task fetch: :environment do
    s, w, n, e = World.bbox
    conn = ActiveRecord::Base.connection
    box = conn.select_one(<<~SQL)
      SELECT ST_XMin(g) x0, ST_YMin(g) y0, ST_XMax(g) x1, ST_YMax(g) y1
      FROM (SELECT ST_Transform(ST_MakeEnvelope(#{w}, #{s}, #{e}, #{n}, 4326), 28992) AS g) t
    SQL
    # the service pages at a thousand features whatever `count` asks for, so walk it
    features = []
    loop do
      query = {
        service: "WFS", version: "2.0.0", request: "GetFeature", typeName: "wijkenbuurten:buurten",
        outputFormat: "application/json", srsName: "EPSG:28992", count: 1000, startIndex: features.size,
        propertyName: "buurtcode,buurtnaam,gemiddeldeWoningwaarde,woningvoorraad,geom",
        bbox: "#{box['x0'].to_i},#{box['y0'].to_i},#{box['x1'].to_i},#{box['y1'].to_i},EPSG:28992"
      }
      print "\rfetching #{features.size}…"
      res = Net::HTTP.get_response(URI("#{WIJKEN_BUURTEN}?#{URI.encode_www_form(query)}"))
      raise "PDOK #{res.code}: #{res.body[0, 200]}" unless res.is_a?(Net::HTTPSuccess)
      page = JSON.parse(res.body)["features"]
      features.concat(page)
      break if page.size < 1000
    end
    puts
    raise "no neighbourhoods returned" if features.blank?

    # CBS writes -99997 and friends where a figure is suppressed or does not apply; those become NULL and fall back
    # to the province median later on.
    n = 0
    features.each do |f|
      p = f["properties"]
      next if f["geometry"].blank?
      value = p["gemiddeldeWoningwaarde"].to_i
      homes = p["woningvoorraad"].to_i
      conn.exec_query(<<~SQL, "buurt", [ p["buurtcode"], p["buurtnaam"], (value if value.positive?), (homes if homes.positive?), f["geometry"].to_json ])
        INSERT INTO neighbourhoods (code, name, woz, dwellings, geom, created_at, updated_at)
        VALUES ($1, $2, $3, $4, ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($5), 28992)), 3)), now(), now())
        ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, woz = EXCLUDED.woz, dwellings = EXCLUDED.dwellings,
          geom = EXCLUDED.geom, updated_at = now()
      SQL
      n += 1
    end
    conn.execute("ANALYZE neighbourhoods")
    priced = Neighbourhood.where.not(woz: nil).count
    puts "neighbourhoods: #{n} upserted, #{priced} with a published house value " \
         "(#{Neighbourhood.where(woz: nil).count} suppressed by CBS, they inherit the median)"
  end

  desc "Price every building: neighbourhood rate × its own floor area"
  task value: :environment do
    conn = ActiveRecord::Base.connection
    raise "no neighbourhoods; run bin/rails woz:fetch first" if Neighbourhood.count.zero?

    # 1. Every pand's footprint and its floor area. The LoD2.2 meshes carry no ground face any more, but the LoD1.3
    #    parts the same import wrote do, one row per part, so a pand's footprint is the sum of its parts. Storeys are
    #    BAG's own count where it has one; where it does not, a footprint over 400 m² is a hall or a barn and gets
    #    one floor, and anything smaller gets its height divided by three — otherwise a fifteen-metre shed comes out
    #    with five fictional storeys, which is how a chemical plant ended up worth nine hundred million euros.
    conn.execute("DROP TABLE IF EXISTS woz_floor")
    conn.execute(<<~SQL)
      CREATE TEMP TABLE woz_floor AS
      SELECT m.id, m.center, b.a AS foot,
             (CASE WHEN m.levels IS NOT NULL THEN GREATEST(1, m.levels)
                   WHEN b.a > #{HALL} THEN 1
                   ELSE LEAST(12, GREATEST(1, round(b.h / 3.0)::int)) END) * b.a AS floor
      FROM building_meshes m
      JOIN (SELECT split_part(source_id, '/', 1) AS pand, sum(ST_Area(geom)) AS a, max(height) AS h
            FROM buildings WHERE source = 'bag3d' GROUP BY 1) b ON b.pand = m.bag_id
    SQL
    conn.execute("CREATE INDEX ON woz_floor USING gist (center)")
    conn.execute("ANALYZE woz_floor")

    # 2. The rate per buurt: what CBS says an average house there is worth, divided by how big an average house
    #    there actually is. Only house-sized buildings count towards that average — a barn and a distribution centre
    #    would drag it to something no house has ever cost. Every building is then priced at that rate, including the
    #    barn: it is an estimate of bricks and floor, not of what anybody would pay for it.
    rated = conn.exec_update(<<~SQL)
      UPDATE neighbourhoods n SET rate = t.rate, updated_at = now()
      FROM (
        SELECT n.id, n.woz * 1000.0 / NULLIF(avg(f.floor), 0) AS rate
        FROM neighbourhoods n JOIN woz_floor f ON ST_Contains(n.geom, f.center)
        WHERE n.woz IS NOT NULL AND f.floor BETWEEN #{HOUSE_MIN} AND #{HOUSE_MAX}
        GROUP BY n.id
      ) t WHERE t.id = n.id AND t.rate BETWEEN 200 AND 20000
    SQL
    median = Neighbourhood.median_rate
    conn.exec_update("UPDATE neighbourhoods SET rate = #{median} WHERE rate IS NULL")
    puts "rates: #{rated} neighbourhoods priced from CBS, the rest at the median #{median.round} €/m²"

    # 3. every building at the rate where it stands, capped so that one chemical plant cannot swamp the counter
    n = conn.exec_update(<<~SQL)
      UPDATE building_meshes m SET woz = LEAST(#{CAP}, round(f.floor * COALESCE(n.rate, #{median})))::int, updated_at = now()
      FROM woz_floor f LEFT JOIN neighbourhoods n ON ST_Contains(n.geom, f.center)
      WHERE f.id = m.id
    SQL
    # the OSM and LoD1.3 fallback boxes get the same treatment off their own footprint and levels
    b = conn.exec_update(<<~SQL)
      UPDATE buildings b SET woz = LEAST(#{CAP}, round(
        ST_Area(b.geom) * (CASE WHEN b.levels IS NOT NULL THEN GREATEST(1, b.levels)
                                WHEN ST_Area(b.geom) > #{HALL} THEN 1
                                ELSE LEAST(12, GREATEST(1, round(b.height / 3.0)::int)) END) *
        COALESCE((SELECT n.rate FROM neighbourhoods n WHERE ST_Contains(n.geom, ST_Centroid(b.geom)) LIMIT 1), #{median})
      ))::int, updated_at = now()
    SQL
    conn.execute("DROP TABLE woz_floor")
    row = conn.select_one(<<~SQL)
      SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY woz)) med, round(avg(woz)) avg, max(woz) max,
             round(percentile_cont(0.5) WITHIN GROUP (ORDER BY woz) FILTER (WHERE woz BETWEEN 60000 AND 1500000)) house
      FROM building_meshes WHERE woz > 0
    SQL
    puts "priced #{n} meshes and #{b} boxes; median #{row['med'].to_i} €, a house-sized one #{row['house'].to_i} €, " \
         "average #{row['avg'].to_i} €, dearest #{row['max'].to_i} €"
  end
end
