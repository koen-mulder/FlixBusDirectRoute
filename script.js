const topAppBarElement = document.querySelector('.mdc-top-app-bar');
const topAppBar = new mdc.topAppBar.MDCTopAppBar(topAppBarElement);

const select = new mdc.select.MDCSelect(document.querySelector('.mdc-select'));

let map = null;
// Ensure these are consistently accessed via window object if they are intended to be global.
// The declarations within DOMContentLoaded were shadowing these.
window.currentRoutesLayer = null;
window.currentStopsLayer = null;
window.fullRoutesGeoJson = null; // Changed from let to window.
window.stopToRouteIdsData = null; // Changed from let to window.
window.globalRouteDetailsMap = {}; // Explicitly global
window.highlightedRouteId = null; // Stores the ID of the highlighted route

// Moved routeStyle to be accessible globally for resetting styles
function routeStyle(feature) {
    if (!feature || !feature.properties) return { color: '#808080', weight: 5, opacity: 0.75 }; // Fallback
    // Use window.globalRouteDetailsMap if direct feature.properties.route_color is not the source of truth after parsing
    const routeDetails = window.globalRouteDetailsMap[feature.properties.route_id];
    // feature.properties.route_color already includes '#' from processing step
    const color = routeDetails ? routeDetails.color : (feature.properties.route_color ? feature.properties.route_color : '#808080');
    return {
        color: color,
        weight: 5,
        opacity: 0.75
    };
}

document.addEventListener('DOMContentLoaded', function() {
    // Initialize Leaflet map
    map = L.map('map', {
        zoomControl: false
    }).setView([51.505, -0.09], 13); // Assign to global map

    L.control.zoom({
        position: 'bottomright'
    }).addTo(map);

    // Create custom panes for layer ordering
    map.createPane('routePane');
    map.getPane('routePane').style.zIndex = 640;
    map.createPane('stopPane');
    map.getPane('stopPane').style.zIndex = 650; // Higher zIndex means on top

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    // File input handling
    const fileInput = document.getElementById('gtfsFile');
    const loadingPopup = document.getElementById('loadingPopup');

    fileInput.addEventListener('change', async function(event) {
        const file = event.target.files[0];
        if (!file) {
            console.log("No file selected.");
            return;
        }
        console.log("File selected:", file.name);

        // Reset any existing route highlighting state
        window.highlightedRouteId = null;
        // Also reset the main stop selector to default
        document.getElementById('stopSelector').value = "";


        loadingPopup.textContent = 'Loading and unzipping file...';
        loadingPopup.style.display = 'block';
        document.body.style.cursor = 'wait'; // Show wait cursor

        try {
            const zip = await JSZip.loadAsync(file);
            console.log("ZIP file loaded.");
            loadingPopup.textContent = 'Parsing GTFS data files...'; // General message before detailed loop

            const requiredFiles = ["routes.txt", "trips.txt", "shapes.txt", "stops.txt", "stop_times.txt"];
            const parsedData = {
                routes: [],
                trips: [],
                shapes: [],
                stops: [],
                stopTimes: []
            };

            for (let i = 0; i < requiredFiles.length; i++) {
                const fileName = requiredFiles[i];
                let fileKey = fileName.split('.')[0]; // Get "routes", "trips", "shapes", "stops", "stop_times"
                if (fileName === "stop_times.txt") {
                    fileKey = "stopTimes"; // Explicitly set to camelCase for stop_times
                } else {
                    fileKey = fileKey.replace(/_/g, ''); // Replaces all underscores
                }
                loadingPopup.textContent = `Parsing ${fileName} (${i + 1} of ${requiredFiles.length})...`;

                const fileInZip = zip.file(fileName);
                if (fileInZip) {
                    console.log(`Processing ${fileName}...`);
                    // Small delay to make text update visible, helpful for very fast parsing
                    // await new Promise(resolve => setTimeout(resolve, 50));
                    const content = await fileInZip.async("string");
                    const result = Papa.parse(content, {
                        header: true,
                        skipEmptyLines: true,
                        dynamicTyping: true // Automatically convert numbers and booleans
                    });
                    parsedData[fileKey] = result.data; // Use fileKey here
                    console.log(`${fileName} parsed successfully. Found ${result.data.length} records.`);
                } else {
                    console.warn(`${fileName} not found in the ZIP.`);
                    // parsedData[fileKey] is already initialized to []
                }
            }

            console.log("Parsed GTFS Data:", parsedData);

            // Populate globalRouteDetailsMap
            window.globalRouteDetailsMap = {}; // Reset for new file
            if (parsedData.routes && parsedData.routes.length > 0) {
                parsedData.routes.forEach(route => {
                    if (route.route_id) {
                        window.globalRouteDetailsMap[route.route_id] = {
                            short_name: route.route_short_name,
                            long_name: route.route_long_name,
                            color: route.route_color ? '#' + route.route_color : '#808080' // Default color
                        };
                    }
                });
            }
            console.log("Global Route Details Map populated:", window.globalRouteDetailsMap);

            // Call processGtfsData with all parsed data
            const processedData = await processGtfsData(
                parsedData.routes,
                parsedData.trips,
                parsedData.shapes,
                parsedData.stops,
                parsedData.stopTimes
            );
            // console.log("Processed GTFS Data (for GeoJSON):", processedData); // Will log routesGeoJson and stopsGeoJson
            loadingPopup.textContent = 'Processing data and building map layers...';

            // Store data for potential filtering and display
            if (processedData) {
                window.fullRoutesGeoJson = processedData.routesGeoJson; // Store for reset
                window.stopToRouteIdsData = processedData.stopToRouteIdsMap;
                // Initial display of all routes and stops
                displayGtfsDataOnMap(processedData.routesGeoJson, processedData.stopsGeoJson);
                // Populate stop selector
                populateStopSelector(processedData.stopsGeoJson);
            }


        } catch (error) {
            console.error("Error processing data or displaying on map:", error);
        } finally {
            loadingPopup.style.display = 'none';
            document.body.style.cursor = 'default'; // Reset cursor
        }
    });

    async function processGtfsData(routes, trips, shapes, stops, stopTimes) { // Added stops, stopTimes
        console.log("Processing GTFS data...");
        // console.log("Received stops for processing:", stops);
        // console.log("Received stopTimes for processing:", stopTimes);

        // Process Stops into GeoJSON Points
        const stopsGeoJsonFeatures = [];
        if (stops && stops.length > 0) {
            stops.forEach(stop => {
                if (stop.stop_id && stop.stop_name && stop.stop_lon != null && stop.stop_lat != null) {
                    stopsGeoJsonFeatures.push({
                        type: "Feature",
                        geometry: {
                            type: "Point",
                            coordinates: [parseFloat(stop.stop_lon), parseFloat(stop.stop_lat)]
                        },
                        properties: {
                            stop_id: stop.stop_id,
                            stop_name: stop.stop_name,
                            stop_code: stop.stop_code,
                            stop_desc: stop.stop_desc,
                            zone_id: stop.zone_id,
                            stop_url: stop.stop_url,
                            location_type: stop.location_type,
                            parent_station: stop.parent_station,
                            wheelchair_boarding: stop.wheelchair_boarding
                            // Add other relevant stop properties if needed
                        }
                    });
                } else {
                    // console.warn("Skipping stop with missing critical data (id, name, lon, or lat):", stop);
                }
            });
        }
        const stopsGeoJson = { type: "FeatureCollection", features: stopsGeoJsonFeatures };
        console.log("Stops GeoJSON created:", stopsGeoJson);

        // Create Stop-Route Linkages (Part 4.2 Step 4)
        console.log("Debug: Raw trips data sample (first 5):", trips ? trips.slice(0, 5) : "Trips data is undefined/null");
        console.log("Debug: Raw stopTimes data sample (first 5):", stopTimes ? stopTimes.slice(0, 5) : "StopTimes data is undefined/null");

        const stopToRouteIdsMap = {};
        const tripToRouteMap = {};

        if (trips && trips.length > 0) {
            trips.forEach(trip => {
                if (trip && trip.trip_id && trip.route_id) {
                    // console.log(`Debug: Adding to tripToRouteMap: trip_id='${trip.trip_id}' (type: ${typeof trip.trip_id}), route_id='${trip.route_id}' (type: ${typeof trip.route_id})`);
                    tripToRouteMap[trip.trip_id] = trip.route_id;
                } else {
                    // console.warn("Debug: Invalid trip object or missing trip_id/route_id in trips array:", trip);
                }
            });
        }
        console.log("Debug: tripToRouteMap constructed:", tripToRouteMap);


        if (stopTimes && stopTimes.length > 0) {
            stopTimes.forEach(stopTime => {
                if (stopTime && stopTime.trip_id && stopTime.stop_id) {
                    // console.log(`Debug: Processing stopTime: trip_id='${stopTime.trip_id}' (type: ${typeof stopTime.trip_id}), stop_id='${stopTime.stop_id}' (type: ${typeof stopTime.stop_id})`);
                    const routeId = tripToRouteMap[stopTime.trip_id];
                    // console.log(`Debug: For stopTime.trip_id '${stopTime.trip_id}', found routeId: '${routeId}' (type: ${typeof routeId})`);

                    if (routeId) {
                        if (!stopToRouteIdsMap[stopTime.stop_id]) {
                            // console.log(`Debug: Initializing Set for stop_id '${stopTime.stop_id}'`);
                            stopToRouteIdsMap[stopTime.stop_id] = new Set();
                        }
                        stopToRouteIdsMap[stopTime.stop_id].add(routeId);
                        // console.log(`Debug: Added route_id '${routeId}' to stop_id '${stopTime.stop_id}'. Current set for stop:`, stopToRouteIdsMap[stopTime.stop_id]);
                    } else {
                         console.warn(`Debug: No route_id found in tripToRouteMap for trip_id '${stopTime.trip_id}' (referenced by stop_time for stop_id '${stopTime.stop_id}').`);
                    }
                } else {
                    // console.warn("Debug: Invalid stopTime object or missing trip_id/stop_id in stopTimes array:", stopTime);
                }
            });
        }
        // Convert Sets to Arrays
        for (const stopId in stopToRouteIdsMap) {
            stopToRouteIdsMap[stopId] = Array.from(stopToRouteIdsMap[stopId]);
        }
        console.log("Stop to Route IDs Map (after processing):", stopToRouteIdsMap);
        // console.log("Debug: stopToRouteIdsMap final", JSON.parse(JSON.stringify(stopToRouteIdsMap)));


        // Existing: 2. Group Shape Points
        const shapeGeometries = {};
        if (shapes && shapes.length > 0) {
            shapes.forEach(point => {
                if (!point.shape_id || point.shape_pt_lon == null || point.shape_pt_lat == null || point.shape_pt_sequence == null) {
                    // console.warn("Skipping shape point with missing critical data:", point);
                    return;
                }
                if (!shapeGeometries[point.shape_id]) {
                    shapeGeometries[point.shape_id] = [];
                }
                // GeoJSON uses [lon, lat]
                shapeGeometries[point.shape_id].push({
                    lon: parseFloat(point.shape_pt_lon),
                    lat: parseFloat(point.shape_pt_lat),
                    seq: parseInt(point.shape_pt_sequence, 10)
                });
            });

            // Sort points within each shape by sequence
            for (const shapeId in shapeGeometries) {
                shapeGeometries[shapeId].sort((a, b) => a.seq - b.seq);
                // Now transform to just the coordinates array
                let points = shapeGeometries[shapeId].map(p => ({ x: p.lon, y: p.lat }));

                // Simplify the points
                // Tolerance is a critical parameter; 0.0001 is a starting value for lat/lon degrees.
                // Higher tolerance = more simplification = fewer points.
                // highQuality: false for faster simplification.
                const tolerance = 0.001; // Adjusted as per user request
                const highQuality = true;  // Adjusted as per user request

                if (typeof window.simplify !== 'function') {
                    console.error("simplify-js library not loaded correctly or 'simplify' is not a function on window object.");
                    // Fallback: use original points if simplification fails
                    shapeGeometries[shapeId] = points.map(p => [p.x, p.y]); // Ensure original points are in correct [lon, lat] format
                    console.warn(`Simplification skipped for shapeId ${shapeId} due to missing simplify function.`);
                    continue; // Skip to the next shapeId
                }

                let simplifiedPoints = window.simplify(points, tolerance, highQuality);

                // Convert back to [lon, lat] format for GeoJSON
                shapeGeometries[shapeId] = simplifiedPoints.map(p => [p.x, p.y]);
            }
        }
        console.log("Shape geometries grouped, sorted, and simplified:", shapeGeometries);

        // 3. Map Routes to Shapes
        const routeToShapeMap = {};
        if (trips && trips.length > 0) {
            trips.forEach(trip => {
                if (trip.route_id && trip.shape_id) {
                    if (!routeToShapeMap[trip.route_id]) {
                        routeToShapeMap[trip.route_id] = new Set();
                    }
                    routeToShapeMap[trip.route_id].add(trip.shape_id);
                }
            });
        }
        // Convert Sets to Arrays for easier iteration later
        for (const routeId in routeToShapeMap) {
            routeToShapeMap[routeId] = Array.from(routeToShapeMap[routeId]);
        }
        console.log("Route to Shape Map (allows multiple shapes per route):", routeToShapeMap);

        // 4. Build the GeoJSON Features
        const geojsonFeatures = [];
        if (routes && routes.length > 0) {
            routes.forEach(route => {
                const shapeIds = routeToShapeMap[route.route_id]; // This is now an array of shape_ids
                if (shapeIds && shapeIds.length > 0) {
                    shapeIds.forEach(shapeId => {
                        const coordinates = shapeGeometries[shapeId];
                        if (coordinates && coordinates.length > 1) { // A LineString needs at least two points
                            const feature = {
                                type: "Feature",
                                geometry: {
                                    type: "LineString",
                                    coordinates: coordinates
                                },
                                properties: {
                                    route_id: route.route_id,
                                    shape_id: shapeId, // Keep track of which shape this feature represents
                                    route_short_name: route.route_short_name,
                                    route_long_name: route.route_long_name,
                                    route_desc: route.route_desc,
                                    route_type: route.route_type,
                                    route_url: route.route_url,
                                    route_color: route.route_color ? '#' + route.route_color : null, // Ensure # prefix for color
                                    route_text_color: route.route_text_color ? '#' + route.route_text_color : null // Ensure # prefix
                                }
                            };
                            geojsonFeatures.push(feature);
                        } else {
                            // console.warn(`Shape ${shapeId} for route ${route.route_id} has insufficient points.`);
                        }
                    });
                } else {
                    // console.warn(`No shape_ids found for route ${route.route_id}.`);
                }
            });
        }
        console.log("GeoJSON features built:", geojsonFeatures);
        const routesGeoJson = { type: "FeatureCollection", features: geojsonFeatures };

        // 5. Return the Final Object(s)
        return {
            routesGeoJson: routesGeoJson,
            stopsGeoJson: stopsGeoJson, // Include stopsGeoJson created earlier
            stopToRouteIdsMap: stopToRouteIdsMap // Make this available
        };
    }

    // These variables were re-declared here, shadowing the global ones.
    // They have been removed as the global ones (window.currentRoutesLayer, etc.) should be used.
    // let currentRoutesLayer = null;
    // let currentStopsLayer = null;
    // let fullRoutesGeoJson = null;
    // let stopToRouteIdsData = null;
    // let globalRouteDetailsMap = {};
    // window.highlightedRouteLayer = null; // This one was already correctly global

    function populateStopSelector(stopsGeoJson) {
            const selectElement = document.querySelector('.mdc-select');
            const list = selectElement.querySelector('.mdc-list');
        // Clear existing options except the first one
        while (list.children.length > 1) {
            list.removeChild(list.lastChild);
        }

            if (stopsGeoJson && stopsGeoJson.features && stopsGeoJson.features.length > 0) {
                selectElement.classList.add('mdc-select--populated');
            // Sort stops by name for easier selection
            const sortedStops = [...stopsGeoJson.features].sort((a, b) => {
                const nameA = a.properties.stop_name.toLowerCase();
                const nameB = b.properties.stop_name.toLowerCase();
                if (nameA < nameB) return -1;
                if (nameA > nameB) return 1;
                return 0;
            });

            sortedStops.forEach(feature => {
                if (feature.properties && feature.properties.stop_id && feature.properties.stop_name) {
                    const listItem = document.createElement('li');
                    listItem.className = 'mdc-list-item';
                    listItem.dataset.value = feature.properties.stop_id;
                    listItem.innerHTML = `
                        <span class="mdc-list-item__ripple"></span>
                        <span class="mdc-list-item__text">${feature.properties.stop_name}</span>
                    `;
                    list.appendChild(listItem);
                }
            });
        }
    }

    // Event listener for stop selector
    select.listen('MDCSelect:change', () => {
        const selectedStopId = select.value;
        console.log(`Filtering by selectedStopId: '${selectedStopId}' (type: ${typeof selectedStopId})`);

        // Reset any existing route highlighting state when main filter changes
        // The visual unhighlighting will occur as routes are redrawn by displayGtfsDataOnMap.
        window.highlightedRouteId = null;

        if (!window.fullRoutesGeoJson || !window.stopToRouteIdsData) { // Use window.
            console.warn("Data not fully loaded yet for filtering (fullRoutesGeoJson or stopToRouteIdsData is missing).");
            return;
        }

        if (selectedStopId) {
            const routeIdsForStop = window.stopToRouteIdsData[selectedStopId]; // Use window.
            console.log(`Route IDs found for stop '${selectedStopId}':`, routeIdsForStop);

            if (routeIdsForStop && routeIdsForStop.length > 0) {
                const filteredFeatures = window.fullRoutesGeoJson.features.filter(feature => { // Use window.
                    const include = routeIdsForStop.includes(feature.properties.route_id);
                    // console.log(`Route ${feature.properties.route_id} included: ${include}`);
                    return include;
                });
                console.log("Filtered features:", filteredFeatures);
                const filteredRoutes = { type: "FeatureCollection", features: filteredFeatures };
                displayGtfsDataOnMap(filteredRoutes, null);
            } else {
                console.log(`No routes found for stop '${selectedStopId}' in stopToRouteIdsData or list is empty. Displaying no routes.`);
                displayGtfsDataOnMap({ type: "FeatureCollection", features: [] }, null);
            }
        } else {
            // No stop selected (or "-- Select --" chosen), display all routes
            console.log("No stop selected, displaying all routes.");
            displayGtfsDataOnMap(window.fullRoutesGeoJson, null); // Display all routes // Use window.
        }
    });

    function displayGtfsDataOnMap(routesGeoJson, stopsGeoJson) {
        console.log("Displaying GTFS data on map...");

        // Clear Old Route Data
        if (window.currentRoutesLayer) {
            map.removeLayer(window.currentRoutesLayer);
            window.currentRoutesLayer = null;
        }

        // Only clear and re-add stops if stopsGeoJson is provided (i.e., initial load)
        if (stopsGeoJson !== undefined && stopsGeoJson !== null) { // Check specifically for undefined/null
            if (window.currentStopsLayer) { // Using window.currentStopsLayer
                map.removeLayer(window.currentStopsLayer);
                window.currentStopsLayer = null;
            }
        }

        // Styling for Routes is now a global function: routeStyle(feature)

        // 4. Implement onEachFeature Function for Popups
        function onEachRouteFeature(feature, layer) {
            if (feature.properties) {
                let popupContent = `<strong>Route: ${feature.properties.route_short_name || 'N/A'}</strong>`;
                if (feature.properties.route_long_name) {
                    popupContent += `<br>${feature.properties.route_long_name}`;
                }
                if (feature.properties.route_desc) {
                    popupContent += `<br><em>${feature.properties.route_desc}</em>`;
                }
                 if (feature.properties.route_id) {
                    popupContent += `<br><small>ID: ${feature.properties.route_id}</small>`;
                }
                layer.bindPopup(popupContent);
            }
        }

        // Create and Add Routes Layer
        if (routesGeoJson && routesGeoJson.features && routesGeoJson.features.length > 0) {
            window.currentRoutesLayer = L.geoJSON(routesGeoJson, { // Assign to window.currentRoutesLayer
                style: routeStyle,
                onEachFeature: onEachRouteFeature,
                pane: 'routePane' // Assign to routePane
            }).addTo(map);
        } else {
            console.log("No route features to display on map.");
        }

        // Create and Add Stops Layer (only if stopsGeoJson is provided)
        if (stopsGeoJson && stopsGeoJson.features && stopsGeoJson.features.length > 0) {
            window.currentStopsLayer = L.geoJSON(stopsGeoJson, { // Assign to window.currentStopsLayer
                pointToLayer: function (feature, latlng) {
                    // const currentZoom = map.getZoom(); // No longer needed for radius
                    // let radius = 5; // Standard size (default for zoom < 13)
                    // if (currentZoom >= 13) {
                    //     radius = 3; // Smaller size for zoom >= 13
                    // }
                    const fixedRadius = 4; // Use a fixed radius
                    return L.circleMarker(latlng, {
                        radius: fixedRadius, // Use fixed radius
                        fillColor: "pink",
                        color: "#000",
                        weight: 1,
                        opacity: 1,
                        fillOpacity: 0.8,
                        pane: 'stopPane' // Assign to stopPane
                    });
                },
                onEachFeature: function (feature, layer) { // Popup for stops
                    if (feature.properties && feature.properties.stop_name) {
                        const lat = feature.geometry.coordinates[1];
                        const lon = feature.geometry.coordinates[0];
                        const stopId = feature.properties.stop_id;
                        let popupContent = `<strong>Stop: ${feature.properties.stop_name}</strong><br><small>ID: ${stopId}</small>`;

                        if (window.stopToRouteIdsData && window.stopToRouteIdsData[stopId] && window.globalRouteDetailsMap) { // Use window.
                            const routeIds = window.stopToRouteIdsData[stopId]; // Use window.
                            if (routeIds.length > 0) {
                                popupContent += `<br><hr><strong>Servicing Routes:</strong><br>`;
                                let routesHtml = '';
                                routeIds.forEach(routeId => {
                                    const routeDetail = window.globalRouteDetailsMap[routeId]; // Use window.globalRouteDetailsMap
                                    const routeDisplayName = routeDetail ? (routeDetail.short_name || routeId) : routeId;
                                    const routeBgColor = routeDetail ? routeDetail.color : '#808080';
                                    const routeTextColor = getContrastingTextColor(routeBgColor);

                                    routesHtml += `<span class="route-badge" data-route-id="${routeId}" style="background-color:${routeBgColor}; color:${routeTextColor}; padding: 2px 5px; border-radius: 3px; margin-right: 4px; font-weight:bold; display: inline-block; margin-bottom: 3px; cursor:pointer;">${routeDisplayName}</span>`;
                                });
                                popupContent += routesHtml;
                            } else {
                                // popupContent += "<br><small>No routes directly listed for this stop.</small>";
                            }
                        }

                        popupContent += `<br><br><button onclick="handleFromHere('${stopId}', ${lat}, ${lon})">Show all routes from here</button>`; // Changed text
                        layer.bindPopup(popupContent);

                        // Add event listeners to route badges after popup is opened
                        layer.on('popupopen', function () {
                            const popupNode = this.getPopup().getElement();
                            const badges = popupNode.querySelectorAll('.route-badge[data-route-id]');
                            badges.forEach(badge => {
                                badge.addEventListener('click', function() {
                                    const routeId = this.dataset.routeId;
                                    handleRouteBadgeClick(routeId);
                                });
                            });
                        });
                    }
                }
            }).addTo(map);
        } else {
            console.log("No stop features to display on map.");
        }

        // Fit Map to Bounds
        let boundsToFit = L.latLngBounds();
        let hasFeaturesToFit = false;

        if (window.currentRoutesLayer && typeof window.currentRoutesLayer.getBounds === 'function') {
            // Check if the layer actually has layers itself before getting bounds
            if (Object.keys(window.currentRoutesLayer._layers).length > 0) {
                 const routeBounds = window.currentRoutesLayer.getBounds();
                if (routeBounds.isValid()) {
                    boundsToFit.extend(routeBounds);
                    hasFeaturesToFit = true;
                }
            }
        }

        // Only extend with stops if stopsGeoJson was provided in this call (meaning they were newly added/updated)
        // AND currentStopsLayer was successfully created and has features.
        if (stopsGeoJson && window.currentStopsLayer && typeof window.currentStopsLayer.getBounds === 'function') {
            if (Object.keys(window.currentStopsLayer._layers).length > 0) {
                const stopBounds = window.currentStopsLayer.getBounds();
                if (stopBounds.isValid()) {
                    boundsToFit.extend(stopBounds);
                    hasFeaturesToFit = true;
                }
            }
        }

        if (hasFeaturesToFit && boundsToFit.isValid()) {
            map.fitBounds(boundsToFit); // Re-enabled
        } else {
            console.log("Skipping map.fitBounds: No valid features/bounds to fit. Map view remains.");
        }
    }
});

function handleFromHere(stopId, lat, lon) {
    console.log(`"From here" button clicked for Stop ID: ${stopId}, Lat: ${lat}, Lon: ${lon}`);

    const selector = document.getElementById('stopSelector');
    if (selector) {
        selector.value = stopId;

        // Create and dispatch a 'change' event
        const changeEvent = new Event('change', { bubbles: true });
        selector.dispatchEvent(changeEvent);
    } else {
        console.error("Stop selector not found.");
    }
}

// Helper function to get contrasting text color (white or black) for a given hex background
function getContrastingTextColor(hexColor) {
    if (!hexColor || hexColor.length < 4) return '#000000'; // Default to black if no/invalid color

    let r, g, b;
    if (hexColor.length === 4) { // Handle shorthand hex like #RGB
        r = parseInt(hexColor[1] + hexColor[1], 16);
        g = parseInt(hexColor[2] + hexColor[2], 16);
        b = parseInt(hexColor[3] + hexColor[3], 16);
    } else if (hexColor.length === 7) { // Handle #RRGGBB
        r = parseInt(hexColor.slice(1, 3), 16);
        g = parseInt(hexColor.slice(3, 5), 16);
        b = parseInt(hexColor.slice(5, 7), 16);
    } else {
        return '#000000'; // Invalid format
    }

    // Standard luminance calculation (YIQ)
    const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return (yiq >= 128) ? '#000000' : '#FFFFFF'; // Black text for light backgrounds, white for dark
}

function handleRouteBadgeClick(routeId) {
    console.log("Route badge clicked for routeId:", routeId);
    const clickedRouteId = routeId; // Alias for clarity

    if (!window.currentRoutesLayer) {
        console.warn("window.currentRoutesLayer is not available in handleRouteBadgeClick");
        return;
    }

    // Unhighlight previously highlighted route (all its features)
    if (window.highlightedRouteId) {
        window.currentRoutesLayer.eachLayer(function(layer) {
            if (layer.feature && layer.feature.properties && layer.feature.properties.route_id === window.highlightedRouteId) {
                layer.setStyle(routeStyle(layer.feature));
                // layer.bringToBack(); // Optional: send unhighlighted routes to back
            }
        });
    }

    // If the clicked route is different from the currently highlighted one, then highlight the new one.
    // Otherwise (if same route is clicked again), it means we are toggling it off, and it's already unhighlighted.
    if (window.highlightedRouteId !== clickedRouteId) {
        window.highlightedRouteId = clickedRouteId; // Set new highlighted route
        window.currentRoutesLayer.eachLayer(function(layer) {
            if (layer.feature && layer.feature.properties && layer.feature.properties.route_id === window.highlightedRouteId) {
                layer.setStyle({ color: '#FF0000', weight: 7, opacity: 1.0 });
                layer.bringToFront();
            }
        });
    } else {
        window.highlightedRouteId = null; // Clear highlight if same route clicked (toggle off)
    }

    map.closePopup(); // Close the popup after selection
}
