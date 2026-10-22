import * as THREE from "three";
import { OrbitControls } from "./OrbitControls.js";
import { GLTFLoader } from "./vendor/loaders/GLTFLoader.js";
import { RoomEnvironment } from "./vendor/environments/RoomEnvironment.js";
import { DOORS, LIDS, WHEELS, OPEN_ANGLE, WINDOW_DROP, WINDOW_INSET, windowSillPlane } from "./car-model.mjs";
import { driveClock, wheelAngleForDistance } from "./drive-cycle.mjs";
import { autopilot, motionSource } from "./autopilot-sim.mjs";

const host = document.getElementById("car-view");
const status = document.getElementById("model-status");
let vehicleState = null;
document.addEventListener("vehicle-state", (event) => { vehicleState = event.detail; });

async function start() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.78;
  renderer.localClippingEnabled = true;
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.65;
  room.dispose();
  pmrem.dispose();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 150);
  camera.position.set(14, 9, 17);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 2, 0);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 12;
  controls.maxDistance = 40;
  controls.maxPolarAngle = Math.PI / 2 - 0.03;
  for (const button of document.querySelectorAll("[data-view]")) {
    button.addEventListener("click", () => {
      const cockpit = button.dataset.view === "cockpit";
      const views = { front: [14, 9, 17], side: [22, 6, 0], rear: [14, 9, -17], cockpit: [.6, 3.55, .5] };
      controls.minDistance = cockpit ? .5 : 12;
      camera.fov = cockpit ? 64 : 36;
      camera.updateProjectionMatrix();
      camera.position.set(...views[button.dataset.view]);
      controls.target.set(...(cockpit ? [.1, 2.75, 2.9] : [0, 2, 0]));
      controls.update();
    });
  }
  scene.add(new THREE.HemisphereLight(0xffffff, 0x344451, 1.4));
  for (const [position, intensity] of [[[10, 16, 10], 2], [[-10, 8, -10], 1.2]]) {
    const light = new THREE.DirectionalLight(0xffffff, intensity);
    light.position.set(...position);
    scene.add(light);
  }
  const model = await new GLTFLoader().loadAsync("/static/vehicle-doors.glb");
  const required = (name) => {
    const node = model.scene.getObjectByName(name);
    if (!node) throw new Error(`The modified model is missing ${name}.`);
    return node;
  };
  const hinges = DOORS.map((door) => {
    const node = required(door.id), glass = required(`window_${door.id}`);
    const [x, y, z, constant] = windowSillPlane(door);
    const sill = new THREE.Plane(new THREE.Vector3(x, y, z), constant).normalize();
    sill.constant += sill.normal.dot(new THREE.Vector3(...door.hinge));
    const clip = new THREE.Plane();
    glass.traverse((object) => {
      if (!object.isMesh) return;
      object.material = object.material.clone();
      object.material.clippingPlanes = [clip];
    });
    return { ...door, node, glass, sill, clip };
  });
  const lids = LIDS.map((lid) => ({ ...lid, node: required(lid.id) }));
  const wheels = WHEELS.map((wheel) => ({ ...wheel, node: required(wheel.id) }));
  scene.add(model.scene);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(11, 64),
    new THREE.MeshStandardMaterial({ color: 0x080e15, roughness: .97, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  scene.add(ground);
  const response = await fetch("/api/state");
  if (!response.ok) throw new Error("Could not load local door state.");
  if (!vehicleState) vehicleState = (await response.json()).state;
  const resize = () => {
    const { width, height } = host.getBoundingClientRect();
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(host);
  resize();
  status.textContent = "Pearl white / drag to orbit / scroll to zoom";
  host.dataset.modelReady = "true";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let previous = performance.now();
  renderer.setAnimationLoop((time) => {
    const delta = Math.min((time - previous) / 1000, 0.1);
    previous = time;
    let animating = false;
    const animate = (current, target) => {
      const next = reducedMotion.matches ? target : THREE.MathUtils.damp(current, target, 8, delta);
      const value = Math.abs(next - target) < 0.001 ? target : next;
      if (value !== target) animating = true;
      return value;
    };
    for (const door of hinges) {
      const target = vehicleState.doors[door.id] ? -door.side * OPEN_ANGLE : 0;
      door.node.rotation.y = animate(door.node.rotation.y, target);
      door.node.updateMatrix();
      door.glass.position.y = animate(door.glass.position.y, vehicleState.windows[door.id] ? -WINDOW_DROP : 0);
      door.glass.position.x = -door.side * WINDOW_INSET * (-door.glass.position.y / WINDOW_DROP);
      door.glass.updateMatrix();
      door.node.updateWorldMatrix(true, true);
      door.clip.copy(door.sill).applyMatrix4(door.node.matrixWorld);
      host.dataset[door.id] = door.node.rotation.y.toFixed(4);
      host.dataset[`window_${door.id}`] = door.glass.position.y.toFixed(4);
    }
    for (const lid of lids) {
      lid.node.rotation.x = animate(lid.node.rotation.x, vehicleState.lids[lid.id] ? lid.angle : 0);
      lid.node.updateMatrix();
      host.dataset[lid.id] = lid.node.rotation.x.toFixed(4);
    }
    const simulated = autopilot.snapshot();
    const drive = motionSource.value === "reference" ? driveClock?.sample(time)
      : { speedKmh: simulated.actual_speed_kmh, distanceM: simulated.distance_m };
    for (const wheel of wheels) {
      if (drive && !reducedMotion.matches) {
        wheel.node.rotation.x = wheelAngleForDistance(drive.distanceM);
        wheel.node.updateMatrix();
      }
      host.dataset[wheel.id] = wheel.node.rotation.x.toFixed(4);
    }
    host.dataset.wheelsRolling = String(Boolean(drive && drive.speedKmh > 0 && !reducedMotion.matches));
    host.dataset.speedKmh = drive ? drive.speedKmh.toFixed(4) : "0";
    host.dataset.distanceM = drive ? drive.distanceM.toFixed(4) : "0";
    host.dataset.motionReduced = String(reducedMotion.matches);
    const caption = drive && reducedMotion.matches
      ? "Wheel animation paused / reduced motion / simulated speed remains active"
      : "Pearl white / drag to orbit / scroll to zoom";
    if (status.textContent !== caption) status.textContent = caption;
    host.dataset.animating = String(animating);
    controls.update();
    renderer.render(scene, camera);
  });
  renderer.domElement.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    renderer.setAnimationLoop(null);
    status.textContent = "3D graphics context lost. Reload the cockpit to restore the model.";
    status.classList.add("model-error");
  });
  window.addEventListener("pagehide", () => {
    renderer.setAnimationLoop(null);
    controls.dispose();
    environment.dispose();
    renderer.dispose();
  }, { once: true });
}

start().catch((error) => {
  status.textContent = `3D vehicle unavailable: ${error.message}`;
  status.classList.add("model-error");
  console.error("Vehicle model failed", error);
});
