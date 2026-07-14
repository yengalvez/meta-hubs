#!/usr/bin/env node

// Generates a deterministic Spoke project around a recovered scene GLB.
// It never uploads content or talks to Kubernetes/Reticulum.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PLACEHOLDER_URL = "__RECOVERED_SCENE_ASSET_URL__";
const ROOT_ID = "C6D9A0A8-7C70-4B9D-907F-DADE6BC34401";
const IDS = {
  model: "E401511E-83B0-47A8-885D-1F4BEE94D3B0",
  spawn: "1B7A2E95-D2C6-4233-82B8-F6D0BCB96D29",
  bots: [
    "2C153580-6B0D-43D0-9F95-72A1A29F1AA1",
    "47611622-6CA1-488D-A729-6BCB699501A2",
    "6F9C113A-2046-4594-A50D-BF866FE8D1A3",
    "756B5267-0DE7-4B1C-8934-A67088C171A4",
    "88AE7B2C-D970-47E0-8A26-A3B0967261A5",
    "92277527-B004-4886-A7D1-E6B2C3E571A6",
    "A80344B6-A197-4996-B15A-087842D021A7",
    "B4081267-675F-4824-B58B-91BF05E051A8"
  ],
  seats: ["D8E6DB8E-B480-48E7-A363-9AAE4E5F31B1", "F0E14C01-EFF0-4976-B8B6-E0BEF1F9E1B2"]
};

function usage() {
  process.stdout.write(`Usage:
  node deployment/generate-recovery-spoke-project.js [options]

Options:
  --scene-url URL   Reticulum URL returned after uploading the recovered GLB.
                    Omit it to generate a local placeholder project only.
  --output-dir DIR  Output directory (default: output/media-recovery-project).
  --help            Show this help.

This command only creates local files. It does not upload or publish anything.
`);
}

function parseArgs(argv) {
  const options = {
    sceneUrl: PLACEHOLDER_URL,
    outputDir: path.resolve("output/media-recovery-project")
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--scene-url" || arg === "--output-dir") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--scene-url") options.sceneUrl = value;
      else options.outputDir = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (options.sceneUrl !== PLACEHOLDER_URL) {
    const parsed = new URL(options.sceneUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("--scene-url must use http:// or https://");
    }
  }

  return options;
}

function transform(x = 0, y = 0, z = 0, rotationY = 0) {
  return {
    name: "transform",
    props: {
      position: { x, y, z },
      rotation: { x: 0, y: rotationY, z: 0 },
      scale: { x: 1, y: 1, z: 1 }
    }
  };
}

function visible() {
  return { name: "visible", props: { visible: true } };
}

function editorSettings() {
  return { name: "editor-settings", props: { enabled: true } };
}

function waypoint(overrides = {}) {
  return {
    name: "waypoint",
    props: {
      canBeSpawnPoint: false,
      canBeOccupied: false,
      canBeClicked: false,
      willDisableMotion: false,
      willDisableTeleporting: false,
      snapToNavMesh: false,
      willMaintainInitialOrientation: false,
      ...overrides
    }
  };
}

function buildProject(sceneUrl) {
  const entities = {};
  entities[ROOT_ID] = {
    name: "YenHubs Recovery Scene",
    components: [
      { name: "background", props: { color: "#101725" } },
      {
        name: "audio-settings",
        props: {
          overrideAudioSettings: false,
          avatarDistanceModel: "inverse",
          avatarRolloffFactor: 2,
          avatarRefDistance: 1,
          avatarMaxDistance: 10000,
          mediaVolume: 0.5,
          mediaDistanceModel: "inverse",
          mediaRolloffFactor: 1,
          mediaRefDistance: 1,
          mediaMaxDistance: 10000,
          mediaConeInnerAngle: 360,
          mediaConeOuterAngle: 0,
          mediaConeOuterGain: 0
        }
      },
      editorSettings()
    ]
  };

  let index = 0;
  entities[IDS.model] = {
    name: "RECOVERED OFFICE SCENE",
    components: [
      transform(),
      visible(),
      editorSettings(),
      { name: "gltf-model", props: { src: sceneUrl, attribution: null } },
      { name: "shadow", props: { cast: false, receive: true } },
      { name: "collidable", props: {} },
      { name: "walkable", props: {} },
      { name: "combine", props: {} }
    ],
    parent: ROOT_ID,
    index: index++
  };
  entities[IDS.spawn] = {
    name: "Spawn Point - POSITION MUST BE VERIFIED",
    components: [transform(), visible(), editorSettings(), { name: "spawn-point", props: {} }],
    parent: ROOT_ID,
    index: index++
  };

  const botPositions = [
    [-6, 0, -6],
    [-2, 0, -6],
    [2, 0, -6],
    [6, 0, -6],
    [-6, 0, 6],
    [-2, 0, 6],
    [2, 0, 6],
    [6, 0, 6]
  ];
  IDS.bots.forEach((id, i) => {
    const [x, y, z] = botPositions[i];
    entities[id] = {
      name: `spawbot-recovery-${String(i + 1).padStart(2, "0")} - REPOSITION`,
      components: [transform(x, y, z), visible(), editorSettings(), waypoint()],
      parent: ROOT_ID,
      index: index++
    };
  });

  const seatPositions = [
    [-1, 0, 2],
    [1, 0, 2]
  ];
  IDS.seats.forEach((id, i) => {
    const [x, y, z] = seatPositions[i];
    entities[id] = {
      name: `Seat recovery ${i + 1} - REPOSITION`,
      components: [
        transform(x, y, z),
        visible(),
        editorSettings(),
        waypoint({ canBeOccupied: true, willDisableMotion: true, willMaintainInitialOrientation: true })
      ],
      parent: ROOT_ID,
      index: index++
    };
  });

  return {
    version: 9,
    root: ROOT_ID,
    entities,
    metadata: {
      name: "YenHubs Recovery Scene",
      allowRemixing: false,
      allowPromotion: false,
      previewCameraTransform: {
        elements: [1, 0, 0, 0, 0, 0.9284766908852594, -0.3713906763541037, 0, 0, 0.3713906763541037, 0.9284766908852594, 0, 0, 8, 20, 1]
      }
    }
  };
}

function validateProject(project) {
  const entries = Object.entries(project.entities);
  if (project.version !== 9) throw new Error("Unexpected Spoke project version");
  if (entries.length !== 13 || !project.entities[project.root]) throw new Error("Unexpected entity structure");

  const children = [];
  let models = 0;
  let botWaypoints = 0;
  let sittingWaypoints = 0;
  for (const [id, entity] of entries) {
    if (id === project.root) continue;
    if (!project.entities[entity.parent] || !Number.isInteger(entity.index)) {
      throw new Error(`Invalid parent/index for ${entity.name}`);
    }
    children.push(entity);
    const componentNames = new Set(entity.components.map(component => component.name));
    if (componentNames.has("gltf-model")) models++;
    if (entity.name.startsWith("spawbot-")) botWaypoints++;
    const waypointComponent = entity.components.find(component => component.name === "waypoint");
    if (waypointComponent && waypointComponent.props.willDisableMotion) sittingWaypoints++;
  }

  const indexes = children.map(entity => entity.index).sort((a, b) => a - b);
  if (indexes.some((value, i) => value !== i)) throw new Error("Child indexes are not contiguous");
  if (models !== 1 || botWaypoints !== 8 || sittingWaypoints !== 2) {
    throw new Error("Recovery model/waypoint counts are invalid");
  }
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function writeOutputs(outputDir, project) {
  const files = {
    "recovery-scene.spoke": `${JSON.stringify(project, null, 2)}\n`
  };

  const orderedEntities = Object.values(project.entities).sort((a, b) => (a.index ?? -1) - (b.index ?? -1));
  files["ENTITY-MANIFEST.tsv"] = `${orderedEntities
    .map(entity => {
      const components = (entity.components || []).map(component => component.name).join(",");
      return `${entity.index ?? -1}\t${entity.name}\t${entity.parent || "ROOT"}\t${components}`;
    })
    .join("\n")}\n`;
  files["RECOVERY-NOTES.txt"] = `YenHubs recovery project - local preparation only

1. This project has NOT been uploaded or applied to production.
2. Its scene URL is: ${project.entities[IDS.model].components.find(c => c.name === "gltf-model").props.src}
3. Upload the recovered source GLB through Spoke/Reticulum before importing this project.
4. Visually verify and reposition the Spawn Point, every spawbot-recovery-* waypoint,
   and both Seat recovery waypoints before publishing.
5. Positions are provisional because the final published Spoke project was stored in
   the missing Reticulum volume and cannot be reconstructed exactly.
6. Bot waypoints must keep the spawbot-* prefix.
7. Sitting waypoints use Disable Motion + Can Be Occupied.
8. Publish as a NEW recovery scene and assign it only to a test room first.
`;

  fs.mkdirSync(outputDir, { recursive: true });
  for (const filename of Object.keys(files)) {
    const target = path.join(outputDir, filename);
    if (fs.existsSync(target)) throw new Error(`Refusing to overwrite existing file: ${target}`);
  }
  for (const [filename, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(outputDir, filename), content);
  }
  const checksums = Object.entries(files)
    .map(([filename, content]) => `${sha256(content)}  ${filename}`)
    .join("\n");
  fs.writeFileSync(path.join(outputDir, "SHA256SUMS"), `${checksums}\n`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  const project = buildProject(options.sceneUrl);
  validateProject(project);
  writeOutputs(options.outputDir, project);
  process.stdout.write(`Recovery project generated and validated: ${options.outputDir}\n`);
  process.stdout.write("No network or production changes were made.\n");
} catch (error) {
  process.stderr.write(`Recovery project generation failed: ${error.message}\n`);
  process.exit(1);
}
