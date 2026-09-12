# Pin npm packages by running ./bin/importmap
#
# Three.js is vendored by hand rather than via `bin/importmap pin`: the jspm build splits
# three into chunk files with relative imports, which break once vendored. Instead
# vendor/javascript/three.js is the single-file jsDelivr "+esm" bundle. Addons import the bare
# specifier "three", so vendor each addon file you use and pin it under "three/addons/...":
#
#   curl -sL https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/<path>.js \
#     > vendor/javascript/three--addons--<path with / replaced by -->.js

pin "game"
pin_all_from "app/javascript/game", under: "game"

pin "@rails/actioncable", to: "actioncable.esm.js"

pin "three" # @0.186.0
pin "three/addons/utils/BufferGeometryUtils.js", to: "three--addons--utils--BufferGeometryUtils.js" # @0.186.0
pin "three/addons/effects/OutlineEffect.js", to: "three--addons--effects--OutlineEffect.js" # @0.186.0

# Rapier, the rigid-body engine behind the debris and the collapsing houses (game/Physics.js). The "compat" build is
# one file with the WebAssembly base64-inlined, which is why it vendors like three.js instead of needing a second
# fingerprinted .wasm served beside it:
#
#   curl -sL https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier.es.js > vendor/javascript/rapier.js
#
# preload: false on purpose — it is 2 MB and game/Physics.js imports it dynamically, so ?fysica=0 never fetches it.
pin "@dimforge/rapier3d-compat", to: "rapier.js", preload: false # @0.14.0
