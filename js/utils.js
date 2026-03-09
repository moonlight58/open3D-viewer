// ─── utils.js ────────────────────────────────────────────────────────────────
// Pure helper functions with no BabylonJS dependencies.
// Globals read: menupars, menuparsvalues (set by menu.js)
// ─────────────────────────────────────────────────────────────────────────────

function getUrlArgument(arg) {
    var query = window.location.search.substring(1);
    var vars  = query.split('&');
    for (var i = 0; i < vars.length; i++) {
        var pair = vars[i].split('=');
        if (pair[0] === arg) return pair[1];
    }
    return false;
}

function loadScript(file) {
    var newScript = document.createElement('script');
    newScript.setAttribute('src', file);
    newScript.setAttribute('type', 'text/javascript');
    newScript.setAttribute('async', 'true');
    newScript.onload  = function() { console.log(file + ' loaded successfully.'); };
    newScript.onerror = function() { console.error('Error loading script: ' + file); };
    document.head.appendChild(newScript);
}

function toggleFullScreen(elem) {
    var isFullscreen =
        (document.fullScreenElement   !== undefined && document.fullScreenElement   !== null) ||
        (document.msFullscreenElement !== undefined && document.msFullscreenElement !== null) ||
        (document.mozFullScreen       !== undefined && document.mozFullScreen) ||
        (document.webkitIsFullScreen  !== undefined && document.webkitIsFullScreen);

    if (!isFullscreen) {
        if      (elem.requestFullScreen)       elem.requestFullScreen();
        else if (elem.mozRequestFullScreen)    elem.mozRequestFullScreen();
        else if (elem.webkitRequestFullScreen) elem.webkitRequestFullScreen(Element.ALLOW_KEYBOARD_INPUT);
        else if (elem.msRequestFullscreen)     elem.msRequestFullscreen();
    } else {
        if      (document.cancelFullScreen)        document.cancelFullScreen();
        else if (document.mozCancelFullScreen)     document.mozCancelFullScreen();
        else if (document.webkitCancelFullScreen)  document.webkitCancelFullScreen();
        else if (document.msExitFullscreen)        document.msExitFullscreen();
    }
}

function exportListing() {
    var exportstring = '';
    for (const element of document.getElementsByClassName('ch cp on')) {
        var parentname = element.parentElement.firstChild.textContent;
        if (parentname.startsWith('Left '))  { parentname = parentname.substring(5);  parentname = parentname.concat('_left');  }
        if (parentname.startsWith('Right ')) { parentname = parentname.substring(6); parentname = parentname.concat('_right'); }
        exportstring += parentname.concat('#', element.innerHTML) + '\n';
    }
    navigator.clipboard.writeText(exportstring)
        .then(function()    { prompt('We have copied the active structures list to your clipboard. Please try to paste it somewhere or copy the selected data from below:', exportstring); })
        .catch(function(err){ prompt('Failed to copy text to clipboard! Please copy and paste the selected data from below:', exportstring); });
}

function showLabel(struc, group) {
    document.getElementById('mesh-label').innerHTML =
        '<div class="mesh">'  + struc  + '</div>' +
        '<div class="layer">' + group  + '</div>';
}

// Returns the parent key in menupars whose values contain the given mesh name.
function getParent(struc) {
    for (var i = 0; i < menuparsvalues.length; i++) {
        if (menuparsvalues[i].includes(struc)) return menupars[i];
    }
}