/* ============================================================
   PROJECT TESSERACT — Hand Tracking Hologram
   ============================================================ */

/* ---------- DOM refs ---------- */
const videoEl   = document.getElementById('webcam');
const canvasEl  = document.getElementById('scene');
const statusEl  = document.getElementById('status');
const loaderEl  = document.getElementById('loader');

/* ---------- Global state ---------- */
const state = {
  handVisible: false,
  isFist: false,
  targetX: 0, targetY: 0, targetZ: 0,     // raw palm target (smoothed input)
  smoothX: 0, smoothY: 0, smoothZ: 0,     // interpolated position actually used
  scaleTarget: 0,                         // 0 = hidden, 1 = fully visible
  scaleCurrent: 0,
  rotationSpeed: 0,                       // current rotation speed (eases toward target)
  rotationSpeedTarget: 0,
  lastSeenTime: 0,
  initialized: false,
};

const SMOOTHING = 0.18;        // position lerp factor (lower = smoother/slower)
const SCALE_LERP = 0.08;       // fade in/out speed
const ROTATION_LERP = 0.04;    // easing for rotation speed changes
const HAND_TIMEOUT = 500;      // ms before we consider hand "lost"

/* ============================================================
   1. WEBCAM SETUP
   ============================================================ */
async function initWebcam() {
  // Verify the browser actually exposes the media devices API before using it
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const err = new Error('getUserMedia is not supported in this browser/context');
    err.name = 'MediaDevicesUnsupported';
    throw err;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
  } catch (err) {
    console.error(err);
    console.error('getUserMedia failed:', err.name, '-', err.message);
    throw err;
  }

  // srcObject must be set before play() is called
  videoEl.srcObject = stream;

  return new Promise((resolve, reject) => {
    videoEl.onloadedmetadata = () => {
      videoEl.play()
        .then(() => resolve())
        .catch((err) => {
          console.error(err);
          console.error('video.play() failed:', err.name, '-', err.message);
          reject(err);
        });
    };
  });
}

/* ============================================================
   2. THREE.JS SCENE + BLOOM
   ============================================================ */
let renderer, scene, camera, composer;
let tesseractGroup, particleSystem;
let tesseractLines, tesseractEdgeMaterial;
let clock = new THREE.Clock();

function initThree() {
  renderer = new THREE.WebGLRenderer({
    canvas: canvasEl,
    alpha: true,
    antialias: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(
    50, window.innerWidth / window.innerHeight, 0.1, 100
  );
  camera.position.set(0, 0, 6);

  // Soft ambient + point light for subtle depth on wireframe glow
  scene.add(new THREE.AmbientLight(0x224466, 1.2));
  const pointLight = new THREE.PointLight(0x00f5ff, 2, 10);
  pointLight.position.set(0, 0, 3);
  scene.add(pointLight);

  buildTesseract();
  buildParticles();

  // Bloom post-processing
  composer = new THREE.EffectComposer(renderer);
  const renderPass = new THREE.RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloomPass = new THREE.UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    1.4,   // strength
    0.6,   // radius
    0.15   // threshold
  );
  composer.addPass(bloomPass);

  window.addEventListener('resize', onResize);
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
}

/* ============================================================
   3. TESSERACT GEOMETRY (4D hypercube projected to 3D)
   ============================================================ */
function buildTesseract() {
  tesseractGroup = new THREE.Group();
  scene.add(tesseractGroup);

  // Generate 16 vertices of a 4D hypercube (-1/1 in each of 4 dims)
  const verts4D = [];
  for (let i = 0; i < 16; i++) {
    verts4D.push([
      (i & 1) ? 1 : -1,
      (i & 2) ? 1 : -1,
      (i & 4) ? 1 : -1,
      (i & 8) ? 1 : -1,
    ]);
  }

  // Edges connect vertices differing in exactly one coordinate
  const edges = [];
  for (let i = 0; i < 16; i++) {
    for (let j = i + 1; j < 16; j++) {
      let diff = 0;
      for (let k = 0; k < 4; k++) if (verts4D[i][k] !== verts4D[j][k]) diff++;
      if (diff === 1) edges.push([i, j]);
    }
  }

  tesseractGroup.userData.verts4D = verts4D;
  tesseractGroup.userData.edges = edges;

  // Line geometry — positions rebuilt each frame from the 4D->3D projection
  const positions = new Float32Array(edges.length * 2 * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  tesseractEdgeMaterial = new THREE.LineBasicMaterial({
    color: 0x00f5ff,
    transparent: true,
    opacity: 0.85,
    linewidth: 1,
  });

  tesseractLines = new THREE.LineSegments(geometry, tesseractEdgeMaterial);
  tesseractGroup.add(tesseractLines);

  // Faint inner glow core (small icosahedron for extra sci-fi shimmer)
  const coreGeo = new THREE.IcosahedronGeometry(0.15, 1);
  const coreMat = new THREE.MeshBasicMaterial({
    color: 0x00f5ff,
    transparent: true,
    opacity: 0.35,
    wireframe: true,
  });
  const core = new THREE.Mesh(coreGeo, coreMat);
  core.name = 'core';
  tesseractGroup.add(core);

  tesseractGroup.scale.setScalar(0.001); // start hidden
}

/* Rotate the 4D hypercube through two planes (XW and YZ) then project to 3D */
function project4Dto3D(v, angleXW, angleYZ) {
  let [x, y, z, w] = v;

  // Rotate in the X-W plane
  let x1 = x * Math.cos(angleXW) - w * Math.sin(angleXW);
  let w1 = x * Math.sin(angleXW) + w * Math.cos(angleXW);

  // Rotate in the Y-Z plane
  let y1 = y * Math.cos(angleYZ) - z * Math.sin(angleYZ);
  let z1 = y * Math.sin(angleYZ) + z * Math.cos(angleYZ);

  // Perspective projection from 4D -> 3D
  const distance = 3;
  const wFactor = 1 / (distance - w1);
  return [x1 * wFactor, y1 * wFactor, z1 * wFactor];
}

function updateTesseractGeometry(angleXW, angleYZ) {
  const { verts4D, edges } = tesseractGroup.userData;
  const projected = verts4D.map(v => project4Dto3D(v, angleXW, angleYZ));

  const posAttr = tesseractLines.geometry.attributes.position;
  let idx = 0;
  for (const [a, b] of edges) {
    const pa = projected[a], pb = projected[b];
    posAttr.array[idx++] = pa[0];
    posAttr.array[idx++] = pa[1];
    posAttr.array[idx++] = pa[2];
    posAttr.array[idx++] = pb[0];
    posAttr.array[idx++] = pb[1];
    posAttr.array[idx++] = pb[2];
  }
  posAttr.needsUpdate = true;
}

/* ============================================================
   4. FLOATING PARTICLES
   ============================================================ */
function buildParticles() {
  const count = 140;
  const positions = new Float32Array(count * 3);
  const speeds = new Float32Array(count);
  const radii = new Float32Array(count);
  const angles = new Float32Array(count);
  const heights = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const r = 0.9 + Math.random() * 0.9;
    const a = Math.random() * Math.PI * 2;
    const h = (Math.random() - 0.5) * 1.6;
    radii[i] = r;
    angles[i] = a;
    heights[i] = h;
    speeds[i] = 0.15 + Math.random() * 0.35;

    positions[i * 3]     = Math.cos(a) * r;
    positions[i * 3 + 1] = h;
    positions[i * 3 + 2] = Math.sin(a) * r;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.userData = { speeds, radii, angles, heights };

  const material = new THREE.PointsMaterial({
    color: 0x66faff,
    size: 0.025,
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  particleSystem = new THREE.Points(geometry, material);
  tesseractGroup.add(particleSystem);
}

function updateParticles(dt, orbitSpeedMultiplier) {
  const { speeds, radii, angles, heights } = particleSystem.geometry.userData;
  const posAttr = particleSystem.geometry.attributes.position;

  for (let i = 0; i < speeds.length; i++) {
    angles[i] += speeds[i] * dt * orbitSpeedMultiplier;
    posAttr.array[i * 3]     = Math.cos(angles[i]) * radii[i];
    posAttr.array[i * 3 + 1] = heights[i] + Math.sin(clock.elapsedTime * 0.6 + i) * 0.04;
    posAttr.array[i * 3 + 2] = Math.sin(angles[i]) * radii[i];
  }
  posAttr.needsUpdate = true;
}

/* ============================================================
   5. MEDIAPIPE HANDS
   ============================================================ */
function initHandTracking() {
  const hands = new Hands({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });

  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.6,
  });

  hands.onResults(onHandResults);

  const mpCamera = new Camera(videoEl, {
    onFrame: async () => {
      try {
        await hands.send({ image: videoEl });
      } catch (err) {
        console.error(err);
        console.error('MediaPipe frame processing failed:', err.name, '-', err.message);
      }
    },
    width: 1280,
    height: 720,
  });
  mpCamera.start();
}

/* Landmark indices we care about */
const WRIST = 0;
const INDEX_MCP = 5, PINKY_MCP = 17, MIDDLE_MCP = 9;
const FINGERTIPS = [8, 12, 16, 20];   // index, middle, ring, pinky tips
const FINGER_PIPS = [6, 10, 14, 18];  // corresponding lower joints

function onHandResults(results) {
  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    state.handVisible = false;
    return;
  }

  const landmarks = results.multiHandLandmarks[0];
  state.handVisible = true;
  state.lastSeenTime = performance.now();

  // Palm center = average of wrist + finger MCP joints
  const palmPts = [WRIST, INDEX_MCP, MIDDLE_MCP, PINKY_MCP].map(i => landmarks[i]);
  const cx = palmPts.reduce((s, p) => s + p.x, 0) / palmPts.length;
  const cy = palmPts.reduce((s, p) => s + p.y, 0) / palmPts.length;
  const cz = palmPts.reduce((s, p) => s + p.z, 0) / palmPts.length;

  // Convert normalized [0,1] MediaPipe coords -> Three.js world space.
  // MediaPipe x is already mirrored relative to a mirrored display since
  // we flip the video with CSS; landmarks come from the raw (unmirrored)
  // frame, so we mirror x here to match the on-screen mirrored video.
  const mirroredX = 1 - cx;
  const worldX = (mirroredX - 0.5) * 2 * frustumWidthAtDepth(0);
  const worldY = -(cy - 0.5) * 2 * frustumHeightAtDepth(0);
  const worldZ = -cz * 4;

  // Hover the hologram above the palm
  state.targetX = worldX;
  state.targetY = worldY + 0.55;
  state.targetZ = worldZ;

  // Fist detection: fingertips are close to their MCP/PIP joints (curled)
  state.isFist = detectFist(landmarks);
}

function detectFist(landmarks) {
  const wrist = landmarks[WRIST];
  let curledCount = 0;

  for (let i = 0; i < FINGERTIPS.length; i++) {
    const tip = landmarks[FINGERTIPS[i]];
    const pip = landmarks[FINGER_PIPS[i]];
    const tipDist = dist3(tip, wrist);
    const pipDist = dist3(pip, wrist);
    // Curled finger: tip is not farther from wrist than the pip joint
    if (tipDist < pipDist * 1.05) curledCount++;
  }
  return curledCount >= 3;
}

function dist3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/* Helpers to map normalized coords to world-space frustum size at a depth */
function frustumHeightAtDepth(depthFromCamera) {
  const dist = camera.position.z - depthFromCamera;
  const vFOV = (camera.fov * Math.PI) / 180;
  return 2 * Math.tan(vFOV / 2) * dist;
}
function frustumWidthAtDepth(depthFromCamera) {
  return frustumHeightAtDepth(depthFromCamera) * camera.aspect;
}

/* ============================================================
   6. MAIN ANIMATION LOOP
   ============================================================ */
let angleXW = 0, angleYZ = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  const now = performance.now();
  const handActive = state.handVisible && (now - state.lastSeenTime < HAND_TIMEOUT);

  // --- Fade target based on hand presence ---
  state.scaleTarget = handActive ? 1 : 0;
  state.scaleCurrent += (state.scaleTarget - state.scaleCurrent) * SCALE_LERP;

  // --- Rotation speed: full when open palm, eased to 0 on fist / no hand ---
  state.rotationSpeedTarget = (handActive && !state.isFist) ? 0.5 : 0;
  state.rotationSpeed += (state.rotationSpeedTarget - state.rotationSpeed) * ROTATION_LERP;

  // --- Smooth position tracking (low-jitter interpolation) ---
  if (handActive) {
    state.smoothX += (state.targetX - state.smoothX) * SMOOTHING;
    state.smoothY += (state.targetY - state.smoothY) * SMOOTHING;
    state.smoothZ += (state.targetZ - state.smoothZ) * SMOOTHING;
  }

  tesseractGroup.position.set(state.smoothX, state.smoothY, state.smoothZ);

  // Breathing pulse + fade-driven scale
  const breathing = 1 + Math.sin(clock.elapsedTime * 1.6) * 0.03;
  const visibleScale = Math.max(state.scaleCurrent, 0.0001);
  tesseractGroup.scale.setScalar(visibleScale * breathing * 0.9);

  // Overall opacity tied to fade state
  tesseractEdgeMaterial.opacity = 0.85 * state.scaleCurrent;
  particleSystem.material.opacity = 0.75 * state.scaleCurrent;

  // 4D rotation angles advance with eased rotation speed
  angleXW += state.rotationSpeed * dt * 0.6;
  angleYZ += state.rotationSpeed * dt * 0.4;
  updateTesseractGeometry(angleXW, angleYZ);

  // Gentle constant self-spin on top of the 4D tumble for visual richness
  tesseractGroup.rotation.y += state.rotationSpeed * dt * 0.3;

  // Particle orbit — keeps drifting slowly even at rest, stronger when active
  const orbitMultiplier = 0.3 + state.rotationSpeed * 1.4;
  updateParticles(dt, orbitMultiplier);

  // Core pulse
  const core = tesseractGroup.getObjectByName('core');
  if (core) {
    const pulse = 1 + Math.sin(clock.elapsedTime * 2.2) * 0.15;
    core.scale.setScalar(pulse);
    core.rotation.x += dt * 0.4;
    core.rotation.y += dt * 0.6;
  }

  composer.render();

  updateStatusText(handActive);
}

/* ============================================================
   7. STATUS TEXT (minimal, fades away)
   ============================================================ */
let statusStableFrames = 0;
function updateStatusText(handActive) {
  if (handActive) {
    statusEl.textContent = state.isFist ? 'HOLD' : 'ACTIVE';
    statusStableFrames++;
    if (statusStableFrames > 90) {
      statusEl.classList.add('hidden');
    }
  } else {
    statusStableFrames = 0;
    statusEl.classList.remove('hidden');
    statusEl.textContent = 'SHOW YOUR PALM';
  }
}

/* ============================================================
   8. BOOTSTRAP
   ============================================================ */
async function main() {
  try {
    initThree();
  } catch (err) {
    console.error(err);
    console.error('Three.js init failed:', err.name, '-', err.message);
    statusEl.textContent = 'RENDERER INIT FAILED';
    loaderEl.classList.add('hidden');
    return;
  }

  try {
    await initWebcam();
  } catch (err) {
    console.error(err);
    console.error('Camera init failed:', err.name, '-', err.message);
    statusEl.textContent = 'CAMERA ACCESS DENIED';
    loaderEl.classList.add('hidden');
    return; // camera did not start — do not proceed to hand tracking
  }

  try {
    initHandTracking();
  } catch (err) {
    console.error(err);
    console.error('MediaPipe init failed:', err.name, '-', err.message);
    statusEl.textContent = 'HAND TRACKING FAILED TO LOAD';
    loaderEl.classList.add('hidden');
    return; // camera works, but MediaPipe failed — report that distinctly
  }

  loaderEl.classList.add('hidden');
  statusEl.textContent = 'SHOW YOUR PALM';
  animate();
}

main();
