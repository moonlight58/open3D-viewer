// ─── vr.js ───────────────────────────────────────────────────────────────────
// WebXR setup: right-controller grab/rotate/scale, left-controller circle menu,
// and model pivot management.
//
// Entry point : initVR(xrHelper)
// Globals read: scene, model, hl, cam (set by scene-init.js)
// ─────────────────────────────────────────────────────────────────────────────

var SKIP_NAMES = ['vrBtn', 'BackgroundPlane', 'BackgroundSkybox', 'vrHUDPlane', 'vrMeshListPanel', 'modelPivot', 'vrInfoPanel', 'rayCursor'];

function isModelMesh(m) {
    return !SKIP_NAMES.some(function(p) { return m.name.startsWith(p); });
}

// ─── Model pivot ─────────────────────────────────────────────────────────────
var modelPivot = null;

function ensureModelPivot() {
    if (modelPivot) return modelPivot;

    modelPivot = new BABYLON.TransformNode('modelPivot', scene);
    modelPivot.position = BABYLON.Vector3.Zero();

    var rootNode = scene.getTransformNodeByName('__root__');
    if (rootNode) {
        rootNode.parent = modelPivot;
    } else {
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

    scene.meshes.forEach(function(m) {
        if (!isModelMesh(m)) return;
        m.alwaysSelectAsActiveMesh = true;
        m.computeWorldMatrix(true);
    });

    console.log('modelPivot created, root:', rootNode ? '__root__' : 'fallback');
    return modelPivot;
}

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

    function isVRUIMesh(mesh) {
        var node = mesh;
        while (node) {
            if (node.name) {
                for (var i = 0; i < SKIP_NAMES.length; i++) {
                    if (node.name.startsWith(SKIP_NAMES[i])) return true;
                }
                if (node.name === 'vrRootNode') return true;
            }
            node = node.parent || null;
        }
        return false;
    }

    // Filtre unique pour tous les raycasts de grab / hover
    function isGrabbableMesh(m) {
        return isModelMesh(m) && !isVRUIMesh(m) && m.isVisible;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // RIGHT CONTROLLER
    // ══════════════════════════════════════════════════════════════════════════
    var rightController   = null;

    var rightGrabbed      = false;
    var grabDistance      = 0;
    var manipObserver     = null;

    var grabOffsetWorld   = null;
    var grabRotationInv   = null;
    var grabPivotRotation = null;

    var rightThumbComponent = null;

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

    function startManipLoop() {
        if (manipObserver) return;
        manipObserver = scene.onBeforeRenderObservable.add(function() {
            var ray = getRightRay();
            if (!ray) return;

            // Squeeze droit = agrandir
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
                var hit = scene.pickWithRay(ray, function(m) { return isGrabbableMesh(m); });
                rayCursorMesh.isVisible = !!(hit && hit.hit);
                if (hit && hit.hit) rayCursorMesh.position = hit.pickedPoint;
                return;
            }

            rayCursorMesh.isVisible = false;
            var pivot    = ensureModelPivot();
            var rayTip   = ray.origin.add(ray.direction.scale(grabDistance));
            var ctrlQuat = getControllerQuaternion();

            if (ctrlQuat && grabOffsetWorld && grabRotationInv && grabPivotRotation) {
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

            var tx = 0, ty = 0;
            if (rightThumbComponent && rightThumbComponent.axes) {
                tx = rightThumbComponent.axes.x || 0;
                ty = rightThumbComponent.axes.y || 0;
            }

            var DEAD      = 0.15;
            var dominated = Math.abs(tx) > Math.abs(ty) ? 'x' : 'y';

            if (dominated === 'y' && Math.abs(ty) > DEAD) {
                // Adjust grabDistance (multiplied by a slightly higher factor for better feel)
                grabDistance = Math.max(0.1, Math.min(10, grabDistance - ty * 0.05));
                
                // Note: We intentionally do NOT recalculate grabRotationInv or grabOffsetWorld here. 
                // Leaving them alone allows the previously calculated offset to apply to the newly extended distance!
                
                updateHUD('↕ ' + grabDistance.toFixed(2) + ' m');

            } else if (dominated === 'x' && Math.abs(tx) > DEAD) {
                var deltaY = BABYLON.Quaternion.RotationAxis(BABYLON.Vector3.Up(), tx * 0.04);
                deltaY.multiplyToRef(grabPivotRotation, grabPivotRotation);
                var nowQ2 = getControllerQuaternion();
                if (nowQ2) grabRotationInv = BABYLON.Quaternion.Inverse(nowQ2);
                updateHUD('↻ Rotation');

            } else {
                updateHUD(' Saisi');
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

    xrHelper.input.onControllerAddedObservable.add(function(controller) {
        controller.onMotionControllerInitObservable.add(function(motionController) {
            if (motionController.handness !== 'right') return;
            rightController = controller;

            var thumbComp = null;
            if (motionController.components) {
                var ids = Object.keys(motionController.components);
                console.log('[VR] Composants manette droite :', ids);
                for (var ci = 0; ci < ids.length; ci++) {
                    var c = motionController.components[ids[ci]];
                    if (c.type === 'thumbstick' || ids[ci].indexOf('thumbstick') !== -1) {
                        thumbComp = c;
                        console.log('[VR] Thumbstick trouvé — id:', ids[ci], 'axes:', c.axes);
                        break;
                    }
                }
            }
            if (!thumbComp) {
                thumbComp = motionController.getComponentOfType('thumbstick')
                         || motionController.getComponent('xr-standard-thumbstick');
            }
            rightThumbComponent = thumbComp || null;
            if (!rightThumbComponent) {
                console.warn('[VR] Thumbstick introuvable sur la manette droite.');
            }

            controller.onMeshLoadedObservable.add(function(cm) { createRightHUD(cm); });
            if (controller.grip) createRightHUD(controller.grip);
            startManipLoop();

            var triggerComp = motionController.getComponentOfType('trigger')
                           || motionController.getComponent('xr-standard-trigger');
            if (triggerComp) {
                triggerComp.onButtonStateChangedObservable.add(function(comp) {
                    var pressed = comp.pressed || (comp.value !== undefined && comp.value > 0.5);

                    if (pressed && !rightGrabbed) {
                        if (!rayCursorMesh.isVisible) return;
                        var ray = getRightRay();
                        if (!ray) return;
                        var hit = scene.pickWithRay(ray, function(m) { return isGrabbableMesh(m); });
                        if (!hit || !hit.hit) return;

                        var pivot = ensureModelPivot();
                        grabDistance    = hit.distance;
                        var rayTip      = ray.origin.add(ray.direction.scale(grabDistance));
                        grabOffsetWorld = pivot.position.subtract(rayTip);

                        var ctrlQ       = getControllerQuaternion();
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
    // LEFT CONTROLLER
    // ══════════════════════════════════════════════════════════════════════════
    var vrRootNode   = null;
    var vrBtn3Ds     = [];
    var vrManager    = new BABYLON.GUI.GUI3DManager(scene);
    var leftGripMesh = null;

    // ── Info panel ────────────────────────────────────────────────────────────
    var vrInfoPanel = null;

    var VR_HELP_ROWS = [
        { text: '══════  AIDE VR  ══════',              color: '#93c5fd', h: 32, fs: 20 },
        { text: '',                                     color: '',          h: 6,  fs: 1  },
        { text: '🎮  MANETTE DROITE',                   color: '#fbbf24', h: 28, fs: 19 },
        { text: '  Gâchette      -  Saisir & déplacer', color: '#e5e7eb', h: 24, fs: 16 },
        { text: '  Joystick ↑↓   -  Pousser / tirer',   color: '#e5e7eb', h: 24, fs: 16 },
        { text: '  Joystick ←→  -  Rotation Y',         color: '#e5e7eb', h: 24, fs: 16 },
        { text: '  Grip          -  Agrandir',          color: '#e5e7eb', h: 24, fs: 16 },
        { text: '',                                     color: '',          h: 6,  fs: 1  },
        { text: '🎮  MANETTE GAUCHE',                   color: '#fbbf24', h: 28, fs: 19 },
        { text: '  Grip          -  Rétrécir',          color: '#e5e7eb', h: 24, fs: 16 },
        { text: '  Menu radial   -  Actions',           color: '#e5e7eb', h: 24, fs: 16 },
        { text: '',                                     color: '',          h: 6,  fs: 1  },
        { text: '  Bouton Info pour fermer',            color: '#93c5fd', h: 24, fs: 15 }
    ];

    function toggleVRInfoPanel() {
        if (vrMeshListPanel) {
            disposeMeshListPanel();
        }

        if (vrInfoPanel) { 
            vrInfoPanel.dispose(); 
            vrInfoPanel = null; 
            return; 
        }

        vrInfoPanel = BABYLON.MeshBuilder.CreatePlane('vrInfoPanel',
            { width: 0.35, height: 0.40, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
        vrInfoPanel.isPickable = false;

        if (leftGripMesh) {
            vrInfoPanel.parent   = leftGripMesh;
            vrInfoPanel.position = new BABYLON.Vector3(0, 0, -0.2);
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
        stack.paddingLeft = '18px';
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
        console.log('[VR] Info panel créé');
    }

    // ── Bouton Menu conditionnel ──────────────────────────────────────────────
    var menuAvailable = (extension === '.glb') && (Object.keys(cleanmenu).length > 0);

    var BTN_DEFS = [
        {
            label   : ' Info',
            disabled: false,
            action  : function() { toggleVRInfoPanel(); }
        },
        {
            label   : '⟳ Rafraîchir',
            disabled: false,
            action  : function() { window.location.reload(); }
        },
        {
            label   : '󰈆 Quitter VR',
            disabled: false,
            action  : function() {
                if (xrHelper.baseExperience.state === BABYLON.WebXRState.IN_XR) {
                    xrHelper.baseExperience.exitXRAsync()
                        .catch(function(err) { console.warn('Failed to exit VR:', err); });
                }
            }
        },
        {
            label   : menuAvailable ? ' Menu' : ' Menu',
            disabled: !menuAvailable,
            action  : function() {
                if (!menuAvailable) return;
                toggleMeshListPanel();
            }
        }
    ];

    // ── Mesh list panel ───────────────────────────────────────────────────────
    var vrMeshListPanel = null;

    function disposeMeshListPanel() {
        if (vrMeshListPanel) {
            vrMeshListPanel.dispose();
            vrMeshListPanel = null;
        }
    }

    function toggleMeshListPanel() {
        // 1. Close Info Panel if open
        if (vrInfoPanel) {
            vrInfoPanel.dispose(); 
            vrInfoPanel = null; 
        }

        // 2. Toggle Off if already open
        if (vrMeshListPanel) {
            disposeMeshListPanel();
            return;
        }

        // 3. Create the 3D Plane
        vrMeshListPanel = BABYLON.MeshBuilder.CreatePlane('vrMeshListPanel',
            { width: 0.35, height: 0.45, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
        
        // CRITICAL: Must be pickable for GUI rays to interact with it
        vrMeshListPanel.isPickable = true; 
        
        // Attach to left controller, slightly offset so it doesn't clip the hand
        if (leftGripMesh) {
            vrMeshListPanel.parent   = leftGripMesh;
            vrMeshListPanel.position = new BABYLON.Vector3(-0.1, -0.1, -0.1); 
            vrMeshListPanel.rotation = new BABYLON.Vector3(Math.PI / 2, 0, Math.PI); 
        } else {
            vrMeshListPanel.position = new BABYLON.Vector3(0, 1.5, 0.8);
        }

        // 4. Create the GUI Texture (High resolution for crisp text)
        var adt = BABYLON.GUI.AdvancedDynamicTexture.CreateForMesh(vrMeshListPanel, 1024, 1316);
        adt.background = '#4285F4'; // Deep blue background

        // 5. Scroll Viewer for long lists
        var sv = new BABYLON.GUI.ScrollViewer();
        sv.thickness = 0;
        sv.color = "#93c5fd"; // Scrollbar color
        sv.width = "100%";
        sv.height = "100%";
        adt.addControl(sv);

        // 6. Main Container
        var mainStack = new BABYLON.GUI.StackPanel();
        mainStack.width = "100%";
        mainStack.horizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
        sv.addControl(mainStack);

        var sortedKeys = Object.keys(cleanmenu).sort();
        var allChildStacks = []; // Track stacks to auto-close others (Accordion effect)

        // 7. Build Categories and Items
        sortedKeys.forEach(function(parname) {
            var displayParname = parname;
            if (parname.endsWith('_right')) displayParname = 'Right ' + parname.slice(0, -6);
            if (parname.endsWith('_left'))  displayParname = 'Left '  + parname.slice(0, -5);

            var categoryContainer = new BABYLON.GUI.StackPanel();
            categoryContainer.width = "100%";
            mainStack.addControl(categoryContainer);

            // Category Button (The <summary> equivalent)
            var catBtn = BABYLON.GUI.Button.CreateSimpleButton("cat_" + parname, "▶ " + displayParname);
            catBtn.width = "100%";
            catBtn.height = "70px";
            catBtn.color = "white";
            catBtn.background = "#2563eb"; // Lighter blue
            catBtn.thickness = 1;
            catBtn.fontSize = 32;
            catBtn.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
            catBtn.paddingLeft = "10px";
            categoryContainer.addControl(catBtn);

            // Children Stack (The <p> items equivalent)
            var childrenStack = new BABYLON.GUI.StackPanel();
            childrenStack.width = "100%";
            childrenStack.isVisible = false; // Collapsed by default
            categoryContainer.addControl(childrenStack);
            
            allChildStacks.push({ stack: childrenStack, btn: catBtn, name: "▶ " + displayParname });

            // Accordion Toggle Logic
            catBtn.onPointerUpObservable.add(function() {
                var isCurrentlyOpen = childrenStack.isVisible;
                
                // Close all categories first
                allChildStacks.forEach(function(item) {
                    item.stack.isVisible = false;
                    item.btn.textBlock.text = item.name; 
                });

                // If it was closed, open it and change the arrow
                if (!isCurrentlyOpen) {
                    childrenStack.isVisible = true;
                    catBtn.textBlock.text = "▼ " + displayParname;
                }
            });

            // 8. Populate Children
            var childrenNames = cleanmenu[parname];
            childrenNames.forEach(function(childName) {
                var childBtn = BABYLON.GUI.Button.CreateSimpleButton("child_" + childName, childName);
                childBtn.width = "100%";
                childBtn.height = "60px";
                childBtn.color = "white";
                childBtn.background = "#0d47a1"; // Darker blue
                childBtn.thickness = 1;
                childBtn.fontSize = 26;
                childBtn.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
                childBtn.paddingLeft = "40px"; // Indent to show hierarchy
                childrenStack.addControl(childBtn);

                var targetMesh = scene.getMeshByName(childName);
                
                // Track state internally: 0=Default, 1=Highlighted, 2=Hidden
                childBtn.partState = 0; 

                // Sync initial button state with current mesh state
                if (targetMesh) {
                    if (!targetMesh.isVisible) {
                        childBtn.partState = 2;
                        childBtn.color = "#9ca3af"; 
                        childBtn.background = "#111827"; 
                    } else if (hl.hasMesh(targetMesh)) {
                        childBtn.partState = 1;
                        childBtn.background = "#3b82f6"; 
                        childBtn.color = "#fbbf24"; 
                    }
                }

                // 9. Implement the 3-State Click Logic
                childBtn.onPointerUpObservable.add(function() {
                    if (!targetMesh) return;

                    var s = childBtn.partState;

                    if (s === 0) {
                        // State 0 -> 1: Highlight
                        hl.removeAllMeshes(); // Clear others to match web logic
                        hl.addMesh(targetMesh, BABYLON.Color3.Green());
                        childBtn.partState = 1;
                        childBtn.background = "#3b82f6"; // Highlight background
                        childBtn.color = "#fbbf24";      // Yellow text
                        
                    } else if (s === 1) {
                        // State 1 -> 2: Hide
                        hl.removeMesh(targetMesh);
                        targetMesh.isVisible = false;
                        childBtn.partState = 2;
                        childBtn.background = "#111827"; // Dark background
                        childBtn.color = "#9ca3af";      // Gray text
                        
                    } else if (s === 2) {
                        // State 2 -> 0: Restore
                        targetMesh.isVisible = true;
                        childBtn.partState = 0;
                        childBtn.background = "#1e40af"; // Default background
                        childBtn.color = "white";        // Default text
                    }
                });
            });
        });
    }

    function createMenuButton(def, index, total, rootNode) {
        var angle  = (index / total) * Math.PI * 2;
        var radius = 0.07;

        var btn = new BABYLON.GUI.HolographicButton('vrBtn_' + index);
        vrManager.addControl(btn);

        var lbl = new BABYLON.GUI.TextBlock();
        lbl.text         = def.label;
        lbl.color        = def.disabled ? '#666666' : '#eaeaea';
        lbl.fontFamily   = 'EnvyCode RNerd Font';
        lbl.fontSize     = 28;
        lbl.textWrapping = true;
        btn.content = lbl;

        btn.node.scaling  = new BABYLON.Vector3(0.09, 0.055, 0.09);
        btn.node.position = new BABYLON.Vector3(
            Math.sin(angle)  * radius,
            0.08,
            -Math.cos(angle) * radius
        );
        btn.node.rotation = new BABYLON.Vector3(Math.PI / 2 - 0.3, 0, Math.PI);
        btn.node.parent   = rootNode;
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

            var sqL = motionController.getComponentOfType('squeeze')
                   || motionController.getComponent('xr-standard-squeeze');
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

    // ── Nettoyage à la sortie de VR ───────────────────────────────────────────
    xrHelper.baseExperience.onStateChangedObservable.add(function(state) {
        if (state === BABYLON.WebXRState.NOT_IN_XR) {
            stopManipLoop();
            rightGrabbed        = false;
            rightController     = null;
            leftController      = null;
            leftGripMesh        = null;
            rightThumbComponent = null;
            grabOffsetWorld     = null;
            grabRotationInv     = null;
            grabPivotRotation   = null;
            if (rightHUDPlane) { rightHUDPlane.dispose(); rightHUDPlane = null; }
            if (vrInfoPanel)   { vrInfoPanel.dispose();   vrInfoPanel   = null; }
            disposeMeshListPanel();
            disposeVRCircleMenu();
        }
    });

    var babylonBtn = document.querySelector('.babylonVRicon');
    if (babylonBtn) {
        babylonBtn.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background-color:#4285f4;border-radius:5px;color:white;z-index:1000;';
    }
}
