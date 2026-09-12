class AddLevelsToBuildingMeshes < ActiveRecord::Migration[8.1]
  def change
    # 3D BAG b3_bouwlagen: how many floors the building actually has. The client has been guessing it from the wall
    # height (round(h / 3)), which is fine for a terrace and wrong for a shop with a high ground floor or a hall
    # with one 8 m storey — and the interiors are laid out on it.
    add_column :building_meshes, :levels, :integer
  end
end
