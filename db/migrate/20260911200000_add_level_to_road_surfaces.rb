class AddLevelToRoadSurfaces < ActiveRecord::Migration[8.1]
  def change
    # BGT relatieveHoogteligging: 0 is on the ground, 1 a viaduct deck over it, -1 a tunnel under it
    add_column :road_surfaces, :level, :integer, default: 0, null: false
    add_index :road_surfaces, :level
  end
end
