const STANDARD_SCENES = [
  {
    name:"Combat A",
    width:1200,
    height:1688,
    src:"systems/sw25-taka/assets/maps/combat-a-map.webp"
  },
  {
    name:"Combat B",
    width:1709,
    height:1200,
    src:"systems/sw25-taka/assets/maps/combat-b-map.webp"
  },
  {
    name:"Coliseum",
    width:794,
    height:1123,
    gridSize:50,
    src:"systems/sw25-taka/assets/maps/coliseum-map.webp"
  }
];

export async function initializeStandardScenes() {
  if (!game.user.isGM) return;

  const folderName = "Simplified Combat Battlefields";
  let folder = game.folders.find(f => f.name === folderName && f.type === "Scene");
  if (!folder) {
    [folder] = await Folder.createDocuments([{ name: folderName, type: "Scene", parent: null }]);
  }

  const created = [];
  const repaired = [];
  const applyBackground = async (document, scene) => {
    let level = document.firstLevel;
    if (!level) {
      [level] = await document.createEmbeddedDocuments("Level", [{
        name:"Ground",
        background:{ src:scene.src }
      }]);
    } else {
      await level.update({ "background.src":scene.src });
    }
    const thumbnail = await document.createThumbnail({ level });
    await document.update({
      width:scene.width,
      height:scene.height,
      padding:0,
      thumb:thumbnail.thumb
    });
  };

  for (const scene of STANDARD_SCENES) {
    const managed = game.scenes.find(candidate =>
      candidate.name.toLowerCase() === scene.name.toLowerCase() &&
      candidate.getFlag("sw25-taka", "standardCombatMap")
    );
    if (managed) {
      await applyBackground(managed, scene);
      repaired.push(scene.name);
      continue;
    }

    // Never overwrite a user's unrelated scene that happens to share the name.
    if (game.scenes.some(candidate => candidate.name.toLowerCase() === scene.name.toLowerCase())) continue;
    const [document] = await Scene.createDocuments([{
      name:scene.name,
      folder: folder.id,
      navigation:true,
      active:false,
      width:scene.width,
      height:scene.height,
      padding:0,
      levels:[{
        name:"Ground",
        background:{ src:scene.src }
      }],
      grid:{
        type:CONST.GRID_TYPES.GRIDLESS,
        size:scene.gridSize ?? 100,
        distance:1,
        units:"m"
      },
      tokenVision:false,
      fogExploration:false,
      flags:{ "sw25-taka":{ standardCombatMap:true } }
    }]);
    if (document) {
      await applyBackground(document, scene);
      created.push(scene.name);
    }
  }

  if (created.length) ui.notifications.info(`Added ${created.join(" and ")} to the ${folderName} folder.`);
  else if (repaired.length && !game.settings.get("sw25-taka", "standardScenesCreated")) {
    ui.notifications.info(`Updated ${repaired.join(" and ")} with their bundled map images.`);
  }
  await game.settings.set("sw25-taka", "standardScenesCreated", true);
}
