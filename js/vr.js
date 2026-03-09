// ─── vr.js ───────────────────────────────────────────────────────────────────
// WebXR setup: right-controller grab/rotate/scale, left-controller circle menu,
// and model pivot management.
//
// Entry point : initVR(xrHelper)
// Globals read: scene, model, hl, cam (set by scene-init.js)
// ─────────────────────────────────────────────────────────────────────────────

// Mesh name prefixes that belong to the VR UI and should never be treated as
// part of the anatomy model (grabbed, highlighted, etc.).
var SKIP_NAMES = ['vrBtn', 'BackgroundPlane', 'BackgroundSkybox', 'vrHUDPlane', 'vrMeshListPanel', 'modelPivot', 'vrInfoPanel'];

function isModelMesh(m) {
    return !SKIP_NAMES.some(function(p) { return m.name.startsWith(p); });
}

// ─── Model pivot ─────────────────────────────────────────────────────────────
// One TransformNode wraps the whole anatomy hierarchy so that a single
// position / rotation / scale change moves everything at once.
var modelPivot = null;

function ensureModelPivot() {
    if (modelPivot) return modelPivot;

    modelPivot = new BABYLON.TransformNode('modelPivot', scene);
    modelPivot.position = BABYLON.Vector3.Zero();

    // GLB files load under a single __root__ TransformNode.
    // Re-parent only that top node — don't touch its children, or the
    // world transforms of anatomical-right meshes will break.
    var rootNode = scene.getTransformNodeByName('__root__');
    if (rootNode) {
        rootNode.parent = modelPivot;
    } else {
        // Fallback for non-GLB: collect only truly root-level nodes.
        var roots = [];
        scene.transformNodes.forEach(function(n) {
            if (n === modelPivot || n.name === 'vrRootNode') return;
            if (n.parent === null) roots.push(n);
        });
        scene.meshes.forEach(function(m) {
            if (!isModelMesh(m)) return;
            if (m.parent === null) roots.push(m);
        });
        roots.forEach(function(r) { r.parent = modelPivot; });
    }

    // Flush stale bounding cache after re-parenting.
    scene.meshes.forEach(function(m) {
        if (!isModelMesh(m)) return;
        m.alwaysSelectAsActiveMesh = true;
        m.computeWorldMatrix(true);
    });

    console.log('modelPivot created, root:', rootNode ? '__root__' : 'fallback');
    return modelPivot;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main VR initialisation — called once the XR experience is ready.
// ─────────────────────────────────────────────────────────────────────────────
function initVR(xrHelper) {

    ['BackgroundSkybox', 'BackgroundPlane'].forEach(function(name) {
        var m = scene.getMeshByName(name);
        if (m) m.dispose();
    });

    // ── Pointer selection feature ─────────────────────────────────────────────
    try {
        var fm = xrHelper.baseExperience.featuresManager;
        fm.enableFeature(BABYLON.WebXRFeatureName.POINTER_SELECTION, 'stable', {
            xrInput: xrHelper.input,
            enablePointerSelectionOnAllControllers: true
        });
    } catch (e) { console.warn('Pointer selection unavailable:', e); }


    // ══════════════════════════════════════════════════════════════════════════
    // RIGHT CONTROLLER  —  raycast grab, rotate, scale, push/pull
    // ══════════════════════════════════════════════════════════════════════════

    var rightController  = null;
    var leftController   = null;  // referenced by the left-controller section below

    var rightGrabbed     = false;
    var grabDistance     = 0;       // metres along ray at the moment of grab
    var manipObserver    = null;

    // At grab time we snapshot:
    //   grabOffsetWorld   — world vector: ray-tip → pivot origin
    //   grabRotationInv   — inverse of controller quaternion at grab
    //   grabPivotRotation — pivot quaternion at grab
    // Every frame: deltaQ = currentCtrlQ * grabRotationInv
    //              pivot.rotationQuaternion = deltaQ * grabPivotRotation  (no accumulation)
    var grabOffsetWorld   = null;
    var grabRotationInv   = null;
    var grabPivotRotation = null;

    // ── HUD plane above the right controller ─────────────────────────────────
    var rightHUDPlane = null;
    var rightHUDText  = null;

    function createRightHUD(gripMesh) {
        if (rightHUDPlane) rightHUDPlane.dispose();
        rightHUDPlane = BABYLON.MeshBuilder.CreatePlane('vrHUDPlane',
            { width: 0.14, height: 0.048, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
        rightHUDPlane.isPickable = false;
        rightHUDPlane.parent    = gripMesh;
        rightHUDPlane.position  = new BABYLON.Vector3(0, 0.11, 0);
        rightHUDPlane.rotation  = new BABYLON.Vector3(Math.PI / 2, Math.PI, 0);

        var tex = BABYLON.GUI.AdvancedDynamicTexture.CreateForMesh(rightHUDPlane, 512, 192);
        tex.background = '#00000099';

        rightHUDText = new BABYLON.GUI.TextBlock();
        rightHUDText.text        = 'Viser le modèle';
        rightHUDText.color       = '#eaeaea';
        rightHUDText.fontSize    = 34;
        rightHUDText.fontFamily  = 'EnvyCode RNerd Font';
        rightHUDText.textWrapping = true;
        tex.addControl(rightHUDText);
    }

    function updateHUD(msg) { if (rightHUDText) rightHUDText.text = msg; }

    // ── Ray helpers ───────────────────────────────────────────────────────────
    function getRightRay() {
        if (!rightController) return null;
        var origin, direction;
        if (rightController.pointer) {
            origin    = rightController.pointer.absolutePosition.clone();
            direction = rightController.pointer.forward.clone().normalize();
        } else if (rightController.grip) {
            origin = rightController.grip.absolutePosition.clone();
            direction = BABYLON.Vector3.TransformNormal(
                new BABYLON.Vector3(0, 0, -1),
                rightController.grip.getWorldMatrix()
            ).normalize();
        } else {
            return null;
        }
        return new BABYLON.Ray(origin, direction, 20);
    }

    function getControllerQuaternion() {
        var grip = rightController && (rightController.pointer || rightController.grip);
        if (!grip) return null;
        if (grip.rotationQuaternion) return grip.rotationQuaternion.clone();
        return BABYLON.Quaternion.FromEulerAngles(grip.rotation.x, grip.rotation.y, grip.rotation.z);
    }

    // ── Ray-cursor dot (shows where the ray hits the model on hover) ──────────
    var rayCursorMesh = (function() {
        var dot = BABYLON.MeshBuilder.CreateSphere('rayCursor', { diameter: 0.012, segments: 6 }, scene);
        dot.isPickable = false;
        dot.isVisible  = false;
        var mat = new BABYLON.StandardMaterial('rayCursorMat', scene);
        mat.emissiveColor   = new BABYLON.Color3(0.2, 0.8, 1.0);
        mat.disableLighting = true;
        dot.material = mat;
        return dot;
    })();

    // ── Per-frame manipulation loop ───────────────────────────────────────────
    function startManipLoop() {
        if (manipObserver) return;
        manipObserver = scene.onBeforeRenderObservable.add(function() {
            var ray = getRightRay();
            if (!ray) return;

            // Right squeeze = scale up (always active, no grab needed)
            var mc0 = rightController && rightController.motionController;
            if (mc0) {
                var sqR = mc0.getComponentOfType('squeeze') || mc0.getComponent('xr-standard-squeeze');
                if (sqR) {
                    var sv0 = sqR.value !== undefined ? sqR.value : (sqR.pressed ? 1.0 : 0);
                    if (sv0 > 0.1) {
                        var piv0 = ensureModelPivot();
                        var s0   = Math.min(5.0, piv0.scaling.x + sv0 * 0.003);
                        piv0.scaling = new BABYLON.Vector3(s0, s0, s0);
                    }
                }
            }

            if (!rightGrabbed) {
                // Hover: show cursor dot when ray hits the model
                var hit = scene.pickWithRay(ray, function(m) { return isModelMesh(m) && m.isVisible; });
                rayCursorMesh.isVisible = !!(hit && hit.hit);
                if (hit && hit.hit) rayCursorMesh.position = hit.pickedPoint;
                return;
            }

            // ── Grabbed: move pivot while preserving the grab offset ───────────
            rayCursorMesh.isVisible = false;
            var pivot   = ensureModelPivot();
            var rayTip  = ray.origin.add(ray.direction.scale(grabDistance));
            var ctrlQuat = getControllerQuaternion();

            if (ctrlQuat && grabOffsetWorld && grabRotationInv && grabPivotRotation) {
                // deltaQ = currentQ * inv(grabQ)  — fresh every frame, no accumulation
                var deltaQuat = ctrlQuat.multiply(grabRotationInv);

                if (!pivot.rotationQuaternion) pivot.rotationQuaternion = new BABYLON.Quaternion();
                deltaQuat.multiplyToRef(grabPivotRotation, pivot.rotationQuaternion);

                var rotatedOffset = BABYLON.Vector3.TransformCoordinates(
                    grabOffsetWorld,
                    deltaQuat.toRotationMatrix(new BABYLON.Matrix())
                );
                pivot.position = rayTip.add(rotatedOffset);
            } else {
                pivot.position = rayTip;
            }

            // ── Thumbstick: Y = push/pull, X = Y-axis rotation ────────────────
            var mc = rightController.motionController;
            if (mc) {
                var thumbComp = mc.getComponentOfType('thumbstick') || mc.getComponent('xr-standard-thumbstick');
                if (thumbComp && thumbComp.axes) {
                    var tx       = thumbComp.axes.x || 0;
                    var ty       = thumbComp.axes.y || 0;
                    var DEAD     = 0.15;
                    var dominated = Math.abs(tx) > Math.abs(ty) ? 'x' : 'y';

                    if (dominated === 'y' && Math.abs(ty) > DEAD) {
                        // Push / pull — re-snapshot so grab offset stays smooth
                        grabDistance = Math.max(0.1, Math.min(10, grabDistance - ty * 0.02));
                        var nowQ = getControllerQuaternion();
                        if (nowQ && pivot.rotationQuaternion) {
                            grabRotationInv   = BABYLON.Quaternion.Inverse(nowQ);
                            grabPivotRotation = pivot.rotationQuaternion.clone();
                            grabOffsetWorld   = pivot.position.subtract(ray.origin.add(ray.direction.scale(grabDistance)));
                        }
                        updateHUD('↕ ' + grabDistance.toFixed(2) + ' m');

                    } else if (dominated === 'x' && Math.abs(tx) > DEAD) {
                        // Y-axis rotation — mutate the grab snapshot to avoid accumulation
                        var deltaY = BABYLON.Quaternion.RotationAxis(BABYLON.Vector3.Up(), tx * 0.04);
                        deltaY.multiplyToRef(grabPivotRotation, grabPivotRotation);
                        var nowQ2 = getControllerQuaternion();
                        if (nowQ2) grabRotationInv = BABYLON.Quaternion.Inverse(nowQ2);
                        updateHUD('↻ Rotation');

                    } else {
                        updateHUD(' Saisi');
                    }
                } else {
                    updateHUD(' Saisi');
                }
            }
        });
    }

    function stopManipLoop() {
        if (manipObserver) {
            scene.onBeforeRenderObservable.remove(manipObserver);
            manipObserver = null;
        }
        rayCursorMesh.isVisible = false;
    }

    // ── Wire right controller ─────────────────────────────────────────────────
    xrHelper.input.onControllerAddedObservable.add(function(controller) {
        controller.onMotionControllerInitObservable.add(function(motionController) {
            if (motionController.handness !== 'right') return;
            rightController = controller;

            controller.onMeshLoadedObservable.add(function(controllerMesh) { createRightHUD(controllerMesh); });
            if (controller.grip) createRightHUD(controller.grip);
            startManipLoop();

            var triggerComp = motionController.getComponentOfType('trigger') || motionController.getComponent('xr-standard-trigger');
            if (triggerComp) {
                triggerComp.onButtonStateChangedObservable.add(function(comp) {
                    var pressed = comp.pressed || (comp.value !== undefined && comp.value > 0.5);

                    if (pressed && !rightGrabbed) {
                        if (!rayCursorMesh.isVisible) return;  // only grab when hovering the model
                        var ray = getRightRay();
                        if (!ray) return;
                        var hit = scene.pickWithRay(ray, function(m) { return isModelMesh(m) && m.isVisible; });
                        if (!hit || !hit.hit) return;

                        var pivot = ensureModelPivot();
                        grabDistance  = hit.distance;
                        var rayTip    = ray.origin.add(ray.direction.scale(grabDistance));
                        grabOffsetWorld = pivot.position.subtract(rayTip);

                        var ctrlQ     = getControllerQuaternion();
                        grabRotationInv = ctrlQ ? BABYLON.Quaternion.Inverse(ctrlQ) : null;

                        if (pivot.rotationQuaternion) {
                            grabPivotRotation = pivot.rotationQuaternion.clone();
                        } else {
                            grabPivotRotation = BABYLON.Quaternion.FromEulerAngles(
                                pivot.rotation.x, pivot.rotation.y, pivot.rotation.z
                            );
                            pivot.rotationQuaternion = grabPivotRotation.clone();
                        }

                        rightGrabbed = true;
                        updateHUD(' Saisi');

                    } else if (!pressed && rightGrabbed) {
                        rightGrabbed      = false;
                        grabOffsetWorld   = null;
                        grabRotationInv   = null;
                        grabPivotRotation = null;
                        updateHUD('Viser le modèle');
                    }
                });
            } else {
                console.warn('No trigger component on right controller.');
            }
        });
    });


    // ══════════════════════════════════════════════════════════════════════════
    // LEFT CONTROLLER  —  radial button menu + squeeze to scale down
    // ══════════════════════════════════════════════════════════════════════════

    var vrRootNode  = null;
    var vrBtn3Ds    = [];
    var vrManager   = new BABYLON.GUI.GUI3DManager(scene);

    // The grip mesh of the left controller — set when controller connects.
    var leftGripMesh = null;

    // ══════════════════════════════════════════════════════════════════════════
    // INFO PANEL  (attached to left-controller grip, floats above it)
    // ══════════════════════════════════════════════════════════════════════════
    var vrInfoPanel = null;

    var VR_HELP_ROWS = [
        { text: '══════  AIDE VR  ══════',            color: '#93c5fd', h: 32, fs: 20 },
        { text: '',                                    color: '',        h: 6,  fs: 1  },
        { text: '🎮  MANETTE DROITE',                 color: '#fbbf24', h: 28, fs: 19 },
        { text: '  Gâchette      →  Saisir & déplacer', color: '#e5e7eb', h: 24, fs: 16 },
        { text: '  Joystick ↑↓  →  Pousser / tirer',   color: '#e5e7eb', h: 24, fs: 16 },
        { text: '  Joystick ←→  →  Rotation Y',         color: '#e5e7eb', h: 24, fs: 16 },
        { text: '  Grip          →  Agrandir',           color: '#e5e7eb', h: 24, fs: 16 },
        { text: '',                                    color: '',        h: 6,  fs: 1  },
        { text: '🎮  MANETTE GAUCHE',                 color: '#fbbf24', h: 28, fs: 19 },
        { text: '  Grip          →  Rétrécir',           color: '#e5e7eb', h: 24, fs: 16 },
        { text: '  Menu radial   →  Actions',            color: '#e5e7eb', h: 24, fs: 16 },
        { text: '',                                    color: '',        h: 6,  fs: 1  },
        { text: '  Bouton Info pour fermer',            color: '#93c5fd', h: 24, fs: 15 }
    ];

    function toggleVRInfoPanel() {
        console.log('[VR] Info button pressed');
        if (vrInfoPanel) { vrInfoPanel.dispose(); vrInfoPanel = null; return; }

        vrInfoPanel = BABYLON.MeshBuilder.CreatePlane('vrInfoPanel',
            { width: 0.55, height: 0.40, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
        vrInfoPanel.isPickable = false;

        // Anchor to left controller grip if available; otherwise world-space fallback
        if (leftGripMesh) {
            vrInfoPanel.parent   = leftGripMesh;
            vrInfoPanel.position = new BABYLON.Vector3(0, 0.52, 0);
            vrInfoPanel.rotation = new BABYLON.Vector3(Math.PI / 2 - 0.3, 0, Math.PI);
        } else {
            vrInfoPanel.position = new BABYLON.Vector3(0, 1.5, 0.8);
        }

        var tex = BABYLON.GUI.AdvancedDynamicTexture.CreateForMesh(vrInfoPanel, 640, 465);
        tex.background = '#111827f2';

        var border = new BABYLON.GUI.Rectangle();
        border.width = '100%'; border.height = '100%';
        border.color = '#3b82f6'; border.thickness = 4;
        border.cornerRadius = 14; border.background = 'transparent';
        tex.addControl(border);

        var stack = new BABYLON.GUI.StackPanel();
        stack.isVertical = true;
        stack.paddingTop = '10px'; stack.paddingLeft = '18px';
        tex.addControl(stack);

        VR_HELP_ROWS.forEach(function(row) {
            var tb = new BABYLON.GUI.TextBlock();
            tb.text       = row.text;
            tb.color      = row.color || '#e5e7eb';
            tb.fontSize   = row.fs;
            tb.fontFamily = 'monospace';
            tb.height     = row.h + 'px';
            tb.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
            tb.resizeToFit = false;
            stack.addControl(tb);
        });
        console.log('[VR] Info panel created');
    }

    // ══════════════════════════════════════════════════════════════════════════
    // MESH LIST PANEL
    // ══════════════════════════════════════════════════════════════════════════
    var vrMeshListPanel = null;
    var meshListPage    = 0;
    var MESHES_PER_PAGE = 7;

    function getModelMeshNames() {
        var seen = {}, names = [];
        scene.meshes.forEach(function(m) {
            if (isModelMesh(m) && m.name && !seen[m.name]) {
                seen[m.name] = true;
                names.push(m.name);
            }
        });
        return names.sort();
    }

    function syncHtmlMenu() {
        var ps = document.getElementsByTagName('p');
        for (var i = 0; i < ps.length; i++) {
            var el = ps[i];
            var vis = false;
            scene.meshes.forEach(function(m) { if (m.name === el.innerHTML && m.isVisible) vis = true; });
            el.className = vis ? 'ch cp on' : 'ch cp off';
        }
    }

    function disposeMeshListPanel() {
        if (vrMeshListPanel) { vrMeshListPanel.dispose(); vrMeshListPanel = null; }
    }

    function toggleMeshListPanel() {
        console.log('[VR] Menu button pressed, leftGripMesh=', leftGripMesh ? 'OK' : 'NULL');
        if (vrMeshListPanel) { disposeMeshListPanel(); return; }
        meshListPage = 0;
        buildMeshListPanel();
    }

    function buildMeshListPanel() {
        disposeMeshListPanel();

        var allNames   = getModelMeshNames();
        var totalPages = Math.max(1, Math.ceil(allNames.length / MESHES_PER_PAGE));
        meshListPage   = Math.max(0, Math.min(meshListPage, totalPages - 1));
        var pageNames  = allNames.slice(
            meshListPage * MESHES_PER_PAGE,
            meshListPage * MESHES_PER_PAGE + MESHES_PER_PAGE
        );

        console.log('[VR] buildMeshListPanel: ' + allNames.length + ' meshes, page ' + (meshListPage + 1) + '/' + totalPages);

        // ── Sizes ─────────────────────────────────────────────────────────────
        var PW = 860, PH = 680;
        var PANEL_W = 0.86, PANEL_H = 0.68;
        var HDR_H = 56, FOOT_H = 62, ROW_H = Math.floor((PH - HDR_H - FOOT_H) / MESHES_PER_PAGE);

        vrMeshListPanel = BABYLON.MeshBuilder.CreatePlane('vrMeshListPanel',
            { width: PANEL_W, height: PANEL_H, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);

        // Anchor to left controller grip — panel floats in front and slightly above
        if (leftGripMesh) {
            vrMeshListPanel.parent   = leftGripMesh;
            vrMeshListPanel.position = new BABYLON.Vector3(0, 0.48, 0);
            vrMeshListPanel.rotation = new BABYLON.Vector3(Math.PI / 2 - 0.3, 0, Math.PI);
        } else {
            vrMeshListPanel.position = new BABYLON.Vector3(0, 1.5, 0.8);
            console.warn('[VR] leftGripMesh not set, panel placed at world origin fallback');
        }
        vrMeshListPanel.isPickable = true;

        var tex = BABYLON.GUI.AdvancedDynamicTexture.CreateForMesh(vrMeshListPanel, PW, PH);
        tex.background = '#0f172af4';

        // Border
        var border = new BABYLON.GUI.Rectangle();
        border.width = '100%'; border.height = '100%';
        border.color = '#3b82f6'; border.thickness = 4;
        border.cornerRadius = 12; border.background = 'transparent';
        tex.addControl(border);

        // ── Header ────────────────────────────────────────────────────────────
        var hdr = new BABYLON.GUI.Rectangle();
        hdr.width = '100%'; hdr.height = HDR_H + 'px';
        hdr.background = '#1e3a5f'; hdr.color = 'transparent'; hdr.thickness = 0;
        hdr.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
        tex.addControl(hdr);

        var hdrTxt = new BABYLON.GUI.TextBlock();
        hdrTxt.text     = '  Structures — ' + allNames.length + ' total   (p.' + (meshListPage + 1) + '/' + totalPages + ')';
        hdrTxt.color    = '#bfdbfe'; hdrTxt.fontSize = 20;
        hdrTxt.height   = HDR_H + 'px';
        hdrTxt.verticalAlignment   = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
        hdrTxt.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
        hdrTxt.paddingLeft = '12px';
        tex.addControl(hdrTxt);

        // Separator
        var sep = new BABYLON.GUI.Rectangle();
        sep.width = '100%'; sep.height = '2px';
        sep.background = '#3b82f6'; sep.color = 'transparent'; sep.thickness = 0;
        sep.top = HDR_H + 'px';
        sep.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
        tex.addControl(sep);

        // ── Rows ──────────────────────────────────────────────────────────────
        // Column X centres (pixels, origin = centre of texture)
        var COL_NAME  = -(PW / 2) + 14;   // left edge
        var BTN_W     = 68, BTN_H = ROW_H - 10;
        var COL_HL    = (PW / 2) - 3 * (BTN_W + 6) - BTN_W / 2 + 4;
        var COL_ISO   = COL_HL  + BTN_W + 6;
        var COL_VIS   = COL_ISO + BTN_W + 6;

        pageNames.forEach(function(meshName, i) {
            var rowTop = HDR_H + 2 + i * ROW_H;
            var isVis  = false, isHl = false;
            scene.meshes.forEach(function(m) {
                if (m.name !== meshName) return;
                if (m.isVisible) isVis = true;
                if (hl.hasMesh(m))  isHl  = true;
            });

            // Row background
            var rowBg = new BABYLON.GUI.Rectangle();
            rowBg.width = '100%'; rowBg.height = ROW_H + 'px';
            rowBg.background = isHl ? '#14532d44' : (i % 2 === 0 ? '#1e293b55' : 'transparent');
            rowBg.color = 'transparent'; rowBg.thickness = 0;
            rowBg.top = rowTop + 'px';
            rowBg.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
            tex.addControl(rowBg);

            // Name label
            var display = meshName.length > 22 ? meshName.slice(0, 20) + '…' : meshName;
            var nameTb  = new BABYLON.GUI.TextBlock();
            nameTb.text      = (isVis ? '● ' : '○ ') + display;
            nameTb.color     = isVis ? '#e2e8f0' : '#64748b';
            nameTb.fontSize  = 16;
            nameTb.width     = '500px';
            nameTb.height    = ROW_H + 'px';
            nameTb.top       = rowTop + 'px';
            nameTb.left      = COL_NAME + 'px';
            nameTb.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
            nameTb.verticalAlignment   = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
            nameTb.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
            nameTb.paddingLeft = '10px';
            tex.addControl(nameTb);

            var btnTop = rowTop + Math.floor((ROW_H - BTN_H) / 2);

            function mkBtn(uid, label, bg, colX, action) {
                var b = BABYLON.GUI.Button.CreateSimpleButton('mlb_' + uid + '_' + i, label);
                b.width      = BTN_W + 'px'; b.height = BTN_H + 'px';
                b.fontSize   = 20; b.color = '#fff';
                b.background = bg; b.cornerRadius = 8;
                b.top  = btnTop + 'px'; b.left = colX + 'px';
                b.verticalAlignment   = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
                b.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
                b.onPointerUpObservable.add(function() {
                    console.log('[VR] btn ' + uid + ' for ' + meshName);
                    action();
                });
                tex.addControl(b);
            }

            // 🟢 Highlight
            mkBtn('hl', '🟢', isHl ? '#16a34a' : '#16a34a55', COL_HL, function() {
                if (isHl) { hl.removeAllMeshes(); }
                else {
                    hl.removeAllMeshes();
                    scene.meshes.forEach(function(m) {
                        if (m.name === meshName) hl.addMesh(m, BABYLON.Color3.Green());
                    });
                }
                buildMeshListPanel();
            });

            // 👁 Isolate — show only this mesh
            mkBtn('iso', '👁', '#2563eb77', COL_ISO, function() {
                scene.meshes.forEach(function(m) {
                    if (!isModelMesh(m)) return;
                    m.isVisible = (m.name === meshName);
                });
                hl.removeAllMeshes();
                scene.meshes.forEach(function(m) {
                    if (m.name === meshName) hl.addMesh(m, BABYLON.Color3.Green());
                });
                syncHtmlMenu();
                buildMeshListPanel();
            });

            // 🚫 Hide / ✅ Show
            mkBtn('vis', isVis ? '🚫' : '✅', isVis ? '#dc262666' : '#05966966', COL_VIS, function() {
                var nv = !isVis;
                scene.meshes.forEach(function(m) {
                    if (m.name !== meshName) return;
                    m.isVisible = nv;
                    if (!nv) hl.removeMesh(m);
                });
                syncHtmlMenu();
                buildMeshListPanel();
            });
        });

        // Separator above footer
        var sep2 = new BABYLON.GUI.Rectangle();
        sep2.width = '100%'; sep2.height = '2px';
        sep2.background = '#334155'; sep2.color = 'transparent'; sep2.thickness = 0;
        sep2.top = (PH - FOOT_H) + 'px';
        sep2.verticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
        tex.addControl(sep2);

        // ── Footer: Prev / Close / Next ───────────────────────────────────────
        var footBtnTop = PH - FOOT_H + Math.floor((FOOT_H - 46) / 2);

        function mkFoot(uid, label, bg, leftPx, action) {
            var b = BABYLON.GUI.Button.CreateSimpleButton('mlf_' + uid, label);
            b.width = '170px'; b.height = '46px';
            b.color = '#e2e8f0'; b.fontSize = 17;
            b.background = bg; b.cornerRadius = 9;
            b.top  = footBtnTop + 'px'; b.left = leftPx + 'px';
            b.verticalAlignment   = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
            b.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
            b.onPointerUpObservable.add(function() {
                console.log('[VR] footer btn ' + uid);
                action();
            });
            tex.addControl(b);
        }

        // Always draw all three so layout is stable
        mkFoot('prev', '◀  Préc.', meshListPage > 0 ? '#334155' : '#1e293b', 20, function() {
            if (meshListPage > 0) { meshListPage--; buildMeshListPanel(); }
        });
        mkFoot('close', '✕  Fermer', '#7f1d1d', Math.floor((PW - 170) / 2), function() {
            disposeMeshListPanel();
        });
        mkFoot('next', 'Suiv.  ▶', (meshListPage + 1 < totalPages) ? '#334155' : '#1e293b',
               PW - 170 - 20, function() {
            if (meshListPage + 1 < totalPages) { meshListPage++; buildMeshListPanel(); }
        });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Radial button definitions
    // ══════════════════════════════════════════════════════════════════════════
    var BTN_DEFS = [
        {
            label : ' Info',
            action: function() { toggleVRInfoPanel(); }
        },
        {
            label : '⟳ Rafraîchir',
            action: function() { window.location.reload(); }
        },
        {
            label : '󰈆 Quitter VR',
            action: function() {
                if (xrHelper.baseExperience.state === BABYLON.WebXRState.IN_XR) {
                    xrHelper.baseExperience.exitXRAsync()
                        .then(function() { console.log('Exited VR mode.'); })
                        .catch(function(err) { console.warn('Failed to exit VR:', err); });
                }
            }
        },
        {
            label : ' Menu',
            action: function() { toggleMeshListPanel(); }
        }
    ];

    // ── Radial (clock-face) button layout ────────────────────────────────────
    // Buttons float in the XZ plane (Y is up). Angle 0 = 12 o'clock, clockwise.
    //   X =  sin(angle) * radius
    //   Z = -cos(angle) * radius
    function createMenuButton(def, index, total, rootNode) {
        var angle  = (index / total) * Math.PI * 2;
        var radius = 0.07;

        var btn = new BABYLON.GUI.HolographicButton('vrBtn_' + index);
        vrManager.addControl(btn);  // must add to manager before accessing btn.node

        var lbl = new BABYLON.GUI.TextBlock();
        lbl.text        = def.label;
        lbl.color       = '#eaeaea';
        lbl.fontFamily  = 'EnvyCode RNerd Font';
        lbl.fontSize    = 28;
        lbl.textWrapping = true;
        btn.content = lbl;

        btn.node.scaling  = new BABYLON.Vector3(0.09, 0.055, 0.09);
        btn.node.position = new BABYLON.Vector3(
            Math.sin(angle)  * radius,
            0.08,
            -Math.cos(angle) * radius
        );
        // All buttons share the same flat orientation — no per-button yaw.
        btn.node.rotation = new BABYLON.Vector3(
            Math.PI / 2 - 0.3,
            0,
            Math.PI
        );
        btn.node.parent = rootNode;
        btn.onPointerUpObservable.add(def.action);
        vrBtn3Ds.push(btn);
    }

    function attachRingToGrip(gripMesh) {
        disposeVRCircleMenu();
        vrRootNode          = new BABYLON.TransformNode('vrRootNode', scene);
        vrRootNode.parent   = gripMesh;
        vrRootNode.position = new BABYLON.Vector3(0, 0.04, 0);
        for (var i = 0; i < BTN_DEFS.length; i++) {
            createMenuButton(BTN_DEFS[i], i, BTN_DEFS.length, vrRootNode);
        }
    }

    function disposeVRCircleMenu() {
        vrBtn3Ds.forEach(function(b) { vrManager.removeControl(b); b.dispose(); });
        vrBtn3Ds = [];
        if (vrRootNode) { vrRootNode.dispose(); vrRootNode = null; }
    }

    // ── Wire left controller ──────────────────────────────────────────────────
    xrHelper.input.onControllerAddedObservable.add(function(controller) {
        controller.onMotionControllerInitObservable.add(function(motionController) {
            if (motionController.handness !== 'left') return;
            leftController = controller;

            controller.onMeshLoadedObservable.add(function(controllerMesh) {
                leftGripMesh = controllerMesh;
                attachRingToGrip(controllerMesh);
            });
            if (controller.grip && !vrRootNode) {
                leftGripMesh = controller.grip;
                attachRingToGrip(controller.grip);
            }

            // Left squeeze = scale down (continuous, frame-by-frame)
            var sqL = motionController.getComponentOfType('squeeze') || motionController.getComponent('xr-standard-squeeze');
            if (sqL) {
                var leftSqueezeObserver = scene.onBeforeRenderObservable.add(function() {
                    var sv = sqL.value !== undefined ? sqL.value : (sqL.pressed ? 1.0 : 0);
                    if (sv > 0.1) {
                        var pivot = ensureModelPivot();
                        var s = Math.max(0.05, pivot.scaling.x - sv * 0.003);
                        pivot.scaling = new BABYLON.Vector3(s, s, s);
                    }
                });
                xrHelper.baseExperience.onStateChangedObservable.add(function(state) {
                    if (state === BABYLON.WebXRState.NOT_IN_XR) {
                        scene.onBeforeRenderObservable.remove(leftSqueezeObserver);
                    }
                });
            }
        });
    });


    // ══════════════════════════════════════════════════════════════════════════
    // Clean up on XR exit
    // ══════════════════════════════════════════════════════════════════════════
    xrHelper.baseExperience.onStateChangedObservable.add(function(state) {
        if (state === BABYLON.WebXRState.NOT_IN_XR) {
            stopManipLoop();
            rightGrabbed      = false;
            rightController   = null;
            leftController    = null;
            leftGripMesh      = null;
            grabOffsetWorld   = null;
            grabRotationInv   = null;
            grabPivotRotation = null;
            if (rightHUDPlane) { rightHUDPlane.dispose(); rightHUDPlane = null; }
            if (vrInfoPanel)   { vrInfoPanel.dispose();   vrInfoPanel   = null; }
            disposeMeshListPanel();
            disposeVRCircleMenu();
        }
    });

    // ── Style the native Babylon VR button ────────────────────────────────────
    var babylonBtn = document.querySelector('.babylonVRicon');
    if (babylonBtn) {
        babylonBtn.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background-color:#4285f4;border-radius:5px;color:white;z-index:1000;';
    }
}