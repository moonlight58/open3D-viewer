// ─── scene-init.js ───────────────────────────────────────────────────────────
// Creates the BabylonJS engine, scene, lights, loads the model, and bootstraps
// the rest of the application once the scene is ready.
//
// Globals set here (available to all other scripts):
//   engine, scene, hl, cam
//   model, extension, modelPath, fileName, folderName, modelBasePath
//   primblockar, struclookup, menupars, menuparsvalues,
//   chopped, cleanmenu, transformnodesar, instructionsOn, glb
// ─────────────────────────────────────────────────────────────────────────────

// ── Shared state ─────────────────────────────────────────────────────────────
var primblockar    = [];
var struclookup    = [];
var menupars       = [];
var menuparsvalues = [];
var chopped        = '';
var cleanmenu      = [];
var transformnodesar = [];
var instructionsOn = false;
var glb            = true;
var cam;   // set in scene.executeWhenReady

var mpopup = document.getElementById('mpopupBox');
var close  = document.getElementsByClassName('close')[0];
var mod    = document.getElementsByClassName('modal-content')[0];

// ── BabylonJS core objects ────────────────────────────────────────────────────
var canvas = document.getElementById('render-canvas');
var engine = new BABYLON.Engine(canvas);
var scene  = new BABYLON.Scene(engine);
var hl     = new BABYLON.HighlightLayer('hl1', scene);
hl.outerGlow = false;

// Disable scene-level frustum clipping (VR per-eye culling is handled in vr.js
// via ensureModelPivot + alwaysSelectAsActiveMesh + computeWorldMatrix).
scene.skipFrustumClipping = true;

// ── Lighting ──────────────────────────────────────────────────────────────────
var hemiLight = new BABYLON.HemisphericLight('hemiLight', new BABYLON.Vector3(0, 1, 0), scene);
hemiLight.intensity = 1.0;

var dirLight = new BABYLON.DirectionalLight('dirLight', new BABYLON.Vector3(-1, -2, -1), scene);
dirLight.intensity = 1.0;

// ── URL parameters ────────────────────────────────────────────────────────────
BABYLON.Scene.DoubleClickDelay = 800;

var model     = getUrlArgument('model');
var set       = getUrlArgument('subset');
var selection = getUrlArgument('export');

if (set)       loadScript('3dmodels/' + model + '/' + set + '.js');
if (selection) document.getElementById('listing').style.visibility = 'visible';
document.title = 'open 3D webviewer : ' + model + ' model';

// ── Resolve model path / extension ───────────────────────────────────────────
var modelBasePath = './3dmodels/';
var modelPath, fileName, extension, folderName;

if      (model.endsWith('.obj'))   { extension = '.obj';   folderName = model.replace('.obj', '');   fileName = model; }
else if (model.endsWith('.glb'))   { extension = '.glb';   folderName = model.replace('.glb', '');   fileName = model; }
else if (model.endsWith('.ply'))   { extension = '.ply';   folderName = model.replace('.ply', '');   fileName = model.replace('.ply', '.splat'); }
else if (model.endsWith('.splat')) { extension = '.splat'; folderName = model.replace('.splat', ''); fileName = model; }
else                               { extension = '.glb';   folderName = model;                       fileName = model + '.glb'; }

modelPath = modelBasePath + folderName + '/';

// ── Load the model ────────────────────────────────────────────────────────────
if (extension === '.obj' || extension === '.glb') {
    BABYLON.SceneLoader.Append(modelPath, fileName, scene);

} else if (extension === '.splat' || extension === '.ply') {
    BABYLON.SceneLoader.ImportMeshAsync('', modelPath, fileName, scene).then(function(result) {
        if (!result.meshes || result.meshes.length === 0) {
            console.warn('No meshes found in the loaded splat file');
            return;
        }
        var gsm = result.meshes[0];

        var mat = new BABYLON.StandardMaterial('splatMaterial', scene);
        mat.disableLighting  = true;
        mat.emissiveColor    = new BABYLON.Color3(1, 1, 1);
        mat.diffuseColor     = new BABYLON.Color3(1, 1, 1);
        mat.backFaceCulling  = false;
        gsm.material = mat;
        gsm.isVisible = true;

        var bounds = gsm.getBoundingInfo();
        var center = bounds.boundingBox.centerWorld;
        var radius = bounds.boundingSphere.radiusWorld;

        if (!scene.activeCamera) scene.createDefaultCamera(true, true, true);
        cam = scene.activeCamera;
        cam.setTarget(center);
        cam.radius              = radius * 2.5;
        cam.alpha               = Math.PI / 4;
        cam.beta                = Math.PI / 3;
        cam.wheelPrecision      = 600;
        cam.pinchPrecision      = 800;
        cam.panningSensibility  = 1600;
        cam.useAutoRotationBehavior = false;

    }).catch(function(error) {
        console.error('Failed to load splat file:', error);
        console.error('Attempted path:', modelPath + fileName);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap — runs once the scene (and model) is fully loaded.
// ─────────────────────────────────────────────────────────────────────────────
scene.executeWhenReady(function() {

    // Fix OBJ material brightness
    if (extension === '.obj') {
        scene.meshes.forEach(function(mesh) {
            if (!mesh.material) return;
            mesh.material.diffuseColor = new BABYLON.Color3(1, 1, 1);
            if (mesh.material.specularColor) mesh.material.specularColor = new BABYLON.Color3(0.2, 0.2, 0.2);
            if (mesh.material.diffuseTexture) mesh.material.diffuseTexture.level = 1.0;
        });
    }

    // Camera
    scene.createDefaultCamera(true, true, true);
    cam = scene.activeCamera;
    cam.wheelPrecision          = 600;
    cam.pinchPrecision          = 800;
    cam.alpha                  += Math.PI;
    cam.panningSensibility      = 1600;
    cam.useAutoRotationBehavior = false;

    // Environment intensity (affects PBR materials and the default environment texture)
    scene.environmentIntensity = 1.6;


    // Disable frustum culling on every mesh (and on any mesh added later).
    scene.meshes.forEach(function(m) { m.alwaysSelectAsActiveMesh = true; });
    scene.onNewMeshAddedObservable.add(function(m) {
        m.alwaysSelectAsActiveMesh = true;
        // Destroy background meshes whenever BabylonJS creates them
        // (happens twice: once for desktop, once when XR initialises)
        if (m.name === 'BackgroundSkybox' || m.name === 'BackgroundPlane') {
            m.dispose();
        }
    });

    // Extra point light
    var pointLight = new BABYLON.PointLight('pointLight', new BABYLON.Vector3(10, 40, 40), scene);
    pointLight.intensity = 1.0;
    pointLight.range     = 200;

    // ── Build anatomy menu (menu.js) ──────────────────────────────────────────
    buildMenu();

    // ── WebXR setup (vr.js) ───────────────────────────────────────────────────
    scene.createDefaultXRExperienceAsync({
        floorMeshes          : [],
        disableTeleportation : true,
        optionalFeatures     : true,
        createDefaultEnvironment: false

    }).then(function(xrHelper) {
        if (!xrHelper || !xrHelper.baseExperience) {
            console.log('WebXR not supported on this device.');
            return;
        }
        initVR(xrHelper);
    }).catch(function(err) { console.warn('WebXR setup failed:', err); });

    // ── Render loop ───────────────────────────────────────────────────────────
    engine.runRenderLoop(function() { scene.render(); });

    // Optimise pointer-move picking (Button3D handles its own picking internally)
    scene.skipPointerMovePicking = false;
    scene.pointerMovePredicate = function(mesh) {
        // Restrict scene raycasts to our UI panels to maintain high performance
        return mesh.name === 'vrMeshListPanel' || mesh.name === 'vrInfoPanel';
    };
    
    // ── Desktop UI event listeners ────────────────────────────────────────────
    document.getElementById('rotation').addEventListener('click', function(e) {
        e.preventDefault();
        cam.useAutoRotationBehavior = !cam.useAutoRotationBehavior;
        cam.autoRotationBehavior.idleRotationSpeed = -0.4;
    });
});

// ── Global UI listeners (work before scene is ready) ─────────────────────────
mod.onclick    = function()      { mpopup.style.display = 'none'; };
close.onclick  = function()      { mpopup.style.display = 'none'; };
window.onclick = function(event) { if (event.target === mpopup) mpopup.style.display = 'none'; };

document.getElementById('info').addEventListener('click',       function(e) { e.preventDefault(); mpopup.style.display = 'block'; });
document.getElementById('home').addEventListener('click',       function(e) { e.preventDefault(); window.location.reload(); });
document.getElementById('fullscreen').addEventListener('click', function(e) { e.preventDefault(); toggleFullScreen(document.body); });
document.getElementById('listing').addEventListener('click',    function(e) { e.preventDefault(); exportListing(); });

window.addEventListener('resize', function() { engine.resize(); });