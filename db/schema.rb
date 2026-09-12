# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_09_12_120000) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "pg_catalog.plpgsql"
  enable_extension "postgis"
  enable_extension "postgis_sfcgal"

  create_table "boundaries", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.geometry "geom", limit: {srid: 28992, type: "multi_polygon"}, null: false
    t.string "name", null: false
    t.datetime "updated_at", null: false
    t.index ["geom"], name: "index_boundaries_on_geom", using: :gist
    t.index ["name"], name: "index_boundaries_on_name", unique: true
  end

  create_table "building_meshes", force: :cascade do |t|
    t.string "bag_id", null: false
    t.geometry "center", limit: {srid: 28992, type: "st_point"}, null: false
    t.datetime "created_at", null: false
    t.geometry "geom", limit: {srid: 28992, type: "multi_polygon", has_z: true}, null: false
    t.float "ground_height"
    t.integer "labels", default: [], null: false, array: true
    t.integer "levels"
    t.string "roof_type"
    t.datetime "updated_at", null: false
    t.integer "woz"
    t.index ["bag_id"], name: "index_building_meshes_on_bag_id", unique: true
    t.index ["center"], name: "index_building_meshes_on_center", using: :gist
  end

  create_table "buildings", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.geometry "geom", limit: {srid: 28992, type: "st_polygon"}, null: false
    t.float "ground_height"
    t.float "height", default: 6.0, null: false
    t.string "kind"
    t.integer "levels"
    t.string "name"
    t.float "roof_height"
    t.string "roof_type"
    t.string "source", default: "osm", null: false
    t.string "source_id", null: false
    t.datetime "updated_at", null: false
    t.integer "woz"
    t.integer "year"
    t.index ["geom"], name: "index_buildings_on_geom", using: :gist
    t.index ["source", "source_id"], name: "index_buildings_on_source_and_source_id", unique: true
    t.index ["source"], name: "index_buildings_on_source"
  end

  create_table "land_covers", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.string "detail"
    t.geometry "geom", limit: {srid: 28992, type: "multi_polygon"}, null: false
    t.string "kind", null: false
    t.string "layer", null: false
    t.string "source_id", null: false
    t.datetime "updated_at", null: false
    t.index ["geom"], name: "index_land_covers_on_geom", using: :gist
    t.index ["layer"], name: "index_land_covers_on_layer"
    t.index ["source_id"], name: "index_land_covers_on_source_id", unique: true
  end

  create_table "neighbourhoods", force: :cascade do |t|
    t.string "code", null: false
    t.datetime "created_at", null: false
    t.integer "dwellings"
    t.geometry "geom", limit: {srid: 28992, type: "multi_polygon"}, null: false
    t.string "name"
    t.float "rate"
    t.datetime "updated_at", null: false
    t.integer "woz"
    t.index ["code"], name: "index_neighbourhoods_on_code", unique: true
    t.index ["geom"], name: "index_neighbourhoods_on_geom", using: :gist
  end

  create_table "places", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.geometry "geom", limit: {srid: 28992, type: "st_point"}, null: false
    t.string "kind", null: false
    t.string "name", null: false
    t.bigint "osm_id", null: false
    t.integer "population"
    t.datetime "updated_at", null: false
    t.index ["geom"], name: "index_places_on_geom", using: :gist
    t.index ["kind"], name: "index_places_on_kind"
    t.index ["osm_id"], name: "index_places_on_osm_id", unique: true
  end

  create_table "poles", force: :cascade do |t|
    t.jsonb "attrs", default: {}, null: false
    t.datetime "created_at", null: false
    t.geometry "geom", limit: {srid: 28992, type: "st_point"}, null: false
    t.string "kind", null: false
    t.string "source", null: false
    t.string "source_id", null: false
    t.datetime "updated_at", null: false
    t.index ["geom"], name: "index_poles_on_geom", using: :gist
    t.index ["kind"], name: "index_poles_on_kind"
    t.index ["source", "source_id"], name: "index_poles_on_source_and_source_id", unique: true
  end

  create_table "road_surfaces", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.string "function"
    t.geometry "geom", limit: {srid: 28992, type: "multi_polygon"}, null: false
    t.string "layer", null: false
    t.integer "level", default: 0, null: false
    t.string "material"
    t.string "source_id", null: false
    t.datetime "updated_at", null: false
    t.index ["function"], name: "index_road_surfaces_on_function"
    t.index ["geom"], name: "index_road_surfaces_on_geom", using: :gist
    t.index ["level"], name: "index_road_surfaces_on_level"
    t.index ["source_id"], name: "index_road_surfaces_on_source_id", unique: true
  end

  create_table "roads", force: :cascade do |t|
    t.boolean "bridge", default: false, null: false
    t.datetime "created_at", null: false
    t.geometry "geom", limit: {srid: 28992, type: "line_string"}, null: false
    t.string "highway", null: false
    t.integer "lanes"
    t.string "name"
    t.boolean "oneway", default: false, null: false
    t.bigint "osm_id", null: false
    t.string "surface"
    t.boolean "tunnel", default: false, null: false
    t.datetime "updated_at", null: false
    t.float "width", default: 5.5, null: false
    t.index ["geom"], name: "index_roads_on_geom", using: :gist
    t.index ["osm_id"], name: "index_roads_on_osm_id", unique: true
  end

  create_table "traffic_signs", force: :cascade do |t|
    t.integer "bearing"
    t.string "black_code"
    t.string "county_code"
    t.datetime "created_at", null: false
    t.string "driving_direction"
    t.date "first_seen_on"
    t.geometry "geom", limit: {srid: 28992, type: "st_point"}, null: false
    t.string "image_url"
    t.string "ndw_id", null: false
    t.string "placement"
    t.string "road_name"
    t.string "rvv_code", null: false
    t.string "side"
    t.string "status", null: false
    t.string "text"
    t.string "town"
    t.datetime "updated_at", null: false
    t.boolean "validated", default: false, null: false
    t.string "zone_code"
    t.index ["geom"], name: "index_traffic_signs_on_geom", using: :gist
    t.index ["ndw_id"], name: "index_traffic_signs_on_ndw_id", unique: true
    t.index ["rvv_code"], name: "index_traffic_signs_on_rvv_code"
  end

  create_table "trees", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.geometry "geom", limit: {srid: 28992, type: "st_point"}, null: false
    t.float "height", null: false
    t.string "kind", null: false
    t.string "source", null: false
    t.string "source_id", null: false
    t.datetime "updated_at", null: false
    t.index ["geom"], name: "index_trees_on_geom", using: :gist
    t.index ["source", "source_id"], name: "index_trees_on_source_and_source_id", unique: true
  end
end
