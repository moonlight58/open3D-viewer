// ─── menu.js ─────────────────────────────────────────────────────────────────
// Builds the anatomy structure menu and wires up all click / pointer / keyboard
// interactions for the desktop viewer.
//
// Globals read   : scene, hl, model, cam (set by scene-init.js)
// Globals written: menupars, menuparsvalues, transformnodesar, cleanmenu
// ─────────────────────────────────────────────────────────────────────────────

function buildMenu() {

    // Shared set for VR persistent highlights (VR GUI has no DOM elements with class 'hl')
    window._vrPersistentHighlights = new Set();

    // ── Mirror overview model left/right ─────────────────────────────────────
    if (model.split('-')[0] === 'overview') {
        scene.transformNodes.forEach(function(el) {
            if (el.name.endsWith('_right')) {
                var clonedparentname = el.name.replace('_right', '_left');
                scene.getTransformNodeByName(el.name).clone(clonedparentname);
                var slottrans = scene.getTransformNodeByName(clonedparentname);
                for (var i = 0; i < slottrans.getChildMeshes(false).length; i++) {
                    var meshnameparts = slottrans.getChildMeshes(false)[i].name.split('.');
                    slottrans.getChildMeshes(false)[i].name = meshnameparts[meshnameparts.length - 2] + '.l';
                }
            }
        });
    }

    // ── Collect transform nodes and build cleanmenu map ───────────────────────
    scene.transformNodes.forEach(function(el) {
        while (el.parent !== null && el.parent.name !== '__root__') { el = el.parent; }
        if (!transformnodesar.includes(el.name)) {
            transformnodesar.push(el.name);
            var childmeshcompactar = [];
            var childMesh = el.getChildMeshes();
            for (var i = 0; i < childMesh.length; i++) {
                // INTENTIONAL: strips everything after the first underscore so that
                // meshes sharing a base name (e.g. femur_001, femur_002) are merged
                // into a single menu entry. This permanently renames the Babylon mesh
                // object — do not rely on original names anywhere after buildMenu() runs.
                var rename_mesh = childMesh[i].name.split('_');
                childMesh[i].name = rename_mesh[0];
                if (!childmeshcompactar.includes(childMesh[i].name)) {
                    childmeshcompactar.push(childMesh[i].name);
                }
            }
            cleanmenu[el.name] = childmeshcompactar;
        }
    });

    // ── Build the menu HTML ───────────────────────────────────────────────────
    menupars       = Object.keys(cleanmenu);
    var sortedmenupars = Object.keys(cleanmenu).sort();
    menuparsvalues = Object.values(cleanmenu);

    var codeBlock = '<details class="menu"><summary>Menu</summary>';
    for (var i = 0; i < sortedmenupars.length; i++) {
        var parname = sortedmenupars[i];
        if (sortedmenupars[i].endsWith('_right')) parname = 'Right ' + parname.slice(0, -6);
        if (sortedmenupars[i].endsWith('_left'))  parname = 'Left '  + parname.slice(0, -5);

        var letindexneeded = menupars.indexOf(sortedmenupars[i]);
        codeBlock += '<details><summary><span id="' + sortedmenupars[i] + '" class="cp par on">' + parname + '</span></summary>';
        for (const element of menuparsvalues[letindexneeded]) {
            codeBlock += '<p class="ch cp on">' + element + '</p>';
        }
        codeBlock += '</details>';
    }
    codeBlock += '</details>';
    document.getElementById('switches-box').innerHTML = codeBlock;

    // ── Accordion: only one <details> open at a time ─────────────────────────
    document.querySelectorAll('details:not(.menu)').forEach(function(D, _, A) {
        D.ontoggle = function() {
            if (D.open) A.forEach(function(d) { if (d !== D) d.open = false; });
        };
    });

    // ── Structure click handlers (toggle visibility / highlight) ─────────────
    var clickp = document.querySelectorAll('.cp');
    clickp.forEach(function(el) {
        el.addEventListener('click', function(e) {
            e.preventDefault();
            hl.removeAllMeshes();
            document.getElementById('mesh-label').innerHTML = '';

            var pstructures = el.parentNode.parentNode.children;
            var vis  = true;
            var from = 'on';
            var to   = 'off';

            if (el.classList.contains('par')) {
                // Parent toggle — show/hide all children
                if (el.classList.contains('on')) { el.classList.replace('on', 'off'); vis = false; }
                else                             { el.classList.replace('off', 'on'); from = 'off'; to = 'on'; }
                for (var i = 1; i < pstructures.length; i++) {
                    scene.meshes.forEach(function(childmesh) {
                        if (childmesh.name === pstructures[i].innerHTML) {
                            childmesh.isVisible = vis;
                            pstructures[i].classList.replace(from, to);
                        }
                    });
                }
            } else {
                // Child toggle — highlight on first click, hide on second
                if (!el.classList.contains('hl') && el.classList.contains('on')) {
                    el.classList.add('hl');
                    scene.meshes.forEach(function(childmesh) {
                        if (childmesh.name === el.innerHTML) {
                            hl.addMesh(childmesh, BABYLON.Color3.Green());
                        }
                    });
                } else {
                    el.classList.remove('hl');
                    if (el.classList.contains('on')) { el.classList.replace('on', 'off'); vis = false; }
                    else                             { el.classList.replace('off', 'on'); from = 'off'; to = 'on'; }
                    scene.meshes.forEach(function(childmesh) {
                        if (childmesh.name === el.innerHTML) childmesh.isVisible = vis;
                    });
                    // Update parent toggle state
                    var collectionmax = el.parentNode.children.length - 1;
                    var countoff = 0;
                    var siblings = el.parentNode.children;
                    for (var j = 1; j < siblings.length; j++) {
                        if (siblings[j].classList.contains('off')) countoff++;
                    }
                    if (countoff === collectionmax) el.parentNode.firstChild.firstElementChild.classList.replace('on', 'off');
                    else                            el.parentNode.firstChild.firstElementChild.classList.replace('off', 'on');
                }
            }
        });
    });

    // ── Pointer: click to highlight, double-click to hide ────────────────────
    scene.onPointerObservable.add(function(evt) {

        var invalidNames = [
            'BackgroundSkybox',
            'BackgroundPlane',
            'vrMeshListPanel',
            'vrInfoPanel',
            'modelPivot',
            'rayCursor',
            '__root__'
        ];

        // Single authoritative pickResult from the observable event data.
        // (The previous code ran a redundant scene.pick() here on every pointer
        // event and immediately shadowed it — removed to avoid the double raycast.)
        var pickResult = evt.pickInfo;

        var isGlbPick = pickResult &&
                        pickResult.hit &&
                        pickResult.pickedMesh &&
                        !invalidNames.includes(pickResult.pickedMesh.name);

        switch (evt.type) {
            case BABYLON.PointerEventTypes.POINTERMOVE:
                hl.removeAllMeshes();

                // Re-apply highlights set by desktop menu click (elements with class 'hl')
                document.querySelectorAll('.cp.hl').forEach(function(hlEl) {
                    var m = scene.getMeshByName(hlEl.innerHTML);
                    if (m && m.isVisible) hl.addMesh(m, BABYLON.Color3.Green());
                });

                // Re-apply highlights set by VR menu (tracked in _vrPersistentHighlights)
                if (window._vrPersistentHighlights) {
                    window._vrPersistentHighlights.forEach(function(meshName) {
                        var m = scene.getMeshByName(meshName);
                        if (m && m.isVisible) hl.addMesh(m, BABYLON.Color3.Green());
                    });
                }

                // Add hover highlight — skip VR UI meshes but don't early-return
                // (returning here would also skip POINTERTAP/POINTERDOUBLETAP
                // processing on that observable tick in some Babylon versions)
                if (pickResult.hit && pickResult.pickedMesh) {
                    if (typeof isModelMesh !== 'function' || isModelMesh(pickResult.pickedMesh)) {
                        hl.addMesh(pickResult.pickedMesh, BABYLON.Color3.Green());
                    }
                }
                break;

            case BABYLON.PointerEventTypes.POINTERTAP:
                if (isGlbPick) {
                    if (hl.hasMesh(pickResult.pickedMesh)) {
                        hl.removeAllMeshes();
                        document.getElementById('mesh-label').innerHTML = '';
                    } else {
                        hl.removeAllMeshes();
                        for (const mesh of scene.meshes) {
                            if (mesh.name === pickResult.pickedMesh.name) {
                                hl.addMesh(mesh, BABYLON.Color3.Green());
                                var dot             = pickResult.pickedMesh.name.charAt(pickResult.pickedMesh.name.length - 2);
                                var reducedmeshname = pickResult.pickedMesh.name;
                                var parentmeshname  = getParent(pickResult.pickedMesh.name);
                                if (dot === '.') { reducedmeshname = reducedmeshname.slice(0, -2); if (parentmeshname) parentmeshname = parentmeshname.split('_').shift(); }
                                showLabel(reducedmeshname, parentmeshname || '');
                            }
                        }
                    }
                }
                break;

            case BABYLON.PointerEventTypes.POINTERDOUBLETAP:
                if (isGlbPick) {
                    document.getElementById('mesh-label').innerHTML = '';
                    hl.removeAllMeshes();
                    for (const mesh of scene.meshes) {
                        if (mesh.name === pickResult.pickedMesh.name) mesh.isVisible = false;
                    }

                    // Static NodeList (querySelectorAll) avoids live-collection
                    // mutation hazard that getElementsByTagName('p') would cause.
                    document.querySelectorAll('p').forEach(function(p) {
                        if (p.innerHTML === pickResult.pickedMesh.name) p.classList.replace('on', 'off');
                    });

                    // Guard against getParent() returning undefined for unrecognised
                    // mesh names (e.g. OBJ meshes, or names changed after buildMenu).
                    var parentKey = getParent(pickResult.pickedMesh.name);
                    if (!parentKey) break;

                    var parentEl = document.getElementById(parentKey);
                    if (!parentEl) break;

                    var parchilds = parentEl.parentNode.parentNode.children;
                    var count = 0;
                    for (var l = 0; l < parchilds.length; l++) {
                        if (parchilds[l].classList.contains('ch') && parchilds[l].classList.contains('on')) count++;
                    }
                    if (count === 0) parentEl.classList.replace('on', 'off');
                }
                break;
        }
    });

    // ── Keyboard: +/- to zoom ─────────────────────────────────────────────────
    scene.onKeyboardObservable.add(function(kbInfo) {
        if (kbInfo.type === BABYLON.KeyboardEventTypes.KEYDOWN) {
            if (kbInfo.event.key === '+') cam.radius -= 0.1;
            if (kbInfo.event.key === '-') cam.radius += 0.1;
        }
    });

    // ── Apply subset visibility from URL param ────────────────────────────────
    if (typeof subset !== 'undefined') {
        subset.forEach(function(item) {
            var check = item.charAt(0);
            if (check === 'l') {
                if (item.charAt(1) === '-') window.document.getElementById(item.slice(2)).click();
                if (item.charAt(1) === '+') window.document.getElementById(item.slice(2)).className = 'cp par on';
            } else {
                // querySelectorAll returns a static NodeList — safe to iterate
                // even if click handlers modify classes during the loop.
                document.querySelectorAll('.ch.cp').forEach(function(element) {
                    if (item.charAt(1) === '+' && item.slice(2) === element.innerHTML) element.click();
                    else if (item.charAt(1) === '-' && item.slice(2) === element.innerHTML) {
                        var m = scene.getMeshByName(element.innerHTML);
                        if (m) m.isVisible = false;
                        element.className = 'ch cp off';
                    }
                });
            }
        });
    }

    if (typeof menuoff !== 'undefined' && menuoff === true) {
        window.document.getElementById('switches-box').style.display = 'none';
    }
} 