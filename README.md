# open3dviewer
Open 3D webviewer for .glb files, developed at the Anatomy department of the Leiden University Medical Center (LUMC). This open 3D webviewer code is provided “as is” under a GPL 3.0 license, see the basic user input below.

Tutorials about further options, viewer hosting, useful links and preparing webmodels: https://caskanatomy.info/open3dviewertutorials

Information about our open 3D anatomy model: https://anatomytool.org/open3dmodel

3D Model (.glb) on a webserver can be viewed interactively within this viewer using a regular webbrowser like Chrome, Edge or Firefox etc. Pressing arrows on the keyboard with focus on the viewport can make the model turn. Pressing + or - will zoom the model in or out. You can also turn structures on or off individually or in groups in the top menu.  

Touch device input: Drag to rotate |  Drag two fingers to pan | Tap to select |  Pinch to zoom in or out
Mouse input: Left-click and drag to rotate | Scroll-wheel to zoom in or out | Right-click and drag to pan | Left-click to select, Double-click to hide

The folder open3dviewer with the viewer code can be downloaded and hosted from a webserver. Calls should normally look similar like this for loading just a basic model:  https://caskanatomy.info/open3dviewer/?model=overview_demo  
You might also want to create an optional subset file for a model to show less structures at the start, which would look similar like this: https://caskanatomy.info/open3dviewer/?model=overview_demo&subset=lessbonesnomuscle
You might want to export selected parent and structure-names in the viewer for easier model (re)building and exporting from Blender. That option can be tuned on with an optional parameter: https://caskanatomy.info/open3dviewer/?model=overview_demo&subset=lessbonesnomuscle&export=on
The optional URL-parameters can be in different order. 
A special use-case is a specially made model which will auto-clone certain right structures to left structures inside the viewer. 

More about all these things can be found at https://caskanatomy.info/open3dviewertutorials

More info about our open 3D anatomy model can be found at: https://anatomytool.org/open3dmodel


