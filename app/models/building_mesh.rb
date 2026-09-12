# LoD2.2 building surfaces from 3D BAG (roof planes + walls) for the buildings whose centre is inside a tile.
class BuildingMesh < ApplicationRecord
  LABEL_GROUND = 0
  LABEL_ROOF   = 1
  LABEL_WALL   = 2

  validates :bag_id, :center, :geom, presence: true

  def self.in_tile(tx, ty)
    env = Road.tile_envelope_sql(tx, ty)
    connection.select_all(<<~SQL).map { |r| r.merge("geojson" => JSON.parse(r["geojson"])) }
      SELECT bag_id, roof_type, ground_height, levels, labels, ST_AsGeoJSON(geom, 2) AS geojson
      FROM building_meshes
      WHERE ST_Intersects(center, #{env})
    SQL
  end
end
