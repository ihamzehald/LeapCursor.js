var LeapCursor = function(options) { this.initialize(options || {}); };

/**
 * 
 */
LeapCursor.prototype = {
	
	canvas				: null,
	controller			: null,
	trainer				: null,
	trainerEnabled		: false,
	evtController		: null,
	
	target				: window,
	
	width				: 110,
	height				: 110,
	
	top					: null,
	left				: null,

	defaultHandPosition	: false,
	
	gestureColor		: '#88CFEB',
	color				: '#000000',
	
	yOffset 			: -160,

	palms				: null,
	fingers				: null,

	renderer 			: null,
			
	material 			: null,
	recordingMaterial 	: null,
	palmGeometry 		: null,
	fingerGeometry 		: null,
	shadowPlane			: null,
	
	camera 				: null,
	light				: null,
	scene 				: null,
	
	lastFrame 			: null,
	speed 				: [0, 0, 0],
	dampening			: 0.95,
	scrollSpeed			: 0.1,

	/**
	 *
	 * @param options
	 */
	initialize: function(options) {

		/*
		 * First, all passed options are set 
		 */
		for (var optionName in options) { if (options.hasOwnProperty(optionName)) { this[optionName] = options[optionName]; }}

		if (options.controller) {
			
			this.trainerEnabled 	= options.controller.controller != null;

		} else {

			this.trainerEnabled 	= typeof LeapTrainer == 'object';
			this.controller			= this.trainerEnabled ? new LeapTrainer.Controller() : new Leap.Controller();			
		}

		this.evtController = (this.trainerEnabled ? this.controller.controller : this.controller);

		/*
		 * The cursor is created when the Leap connects - so if there is no device present, nothing happens.
		 */
		this.evtController.on('connect', function() { this.createCursor(options); }.bind(this));

		if (!this.trainerEnabled) { this.controller.connect(); } else { this.trainer = this.controller; }		
	},

	/**
	 *
	 * @param options
	 */
	createCursor: function() {

		/*
		 * We create a canvas element and append it to the document body - unless a canvas has been passed in the options
		 */
		if (this.canvas == null) {

			this.canvas		= document.createElement('div');

			this.canvas.style.position 	= 'fixed';

			this.canvas.style.width 	= this.width  + 'px';
			this.canvas.style.height 	= this.height + 'px';

			this.canvas.style.zIndex	= 999999999;

			document.body.appendChild(this.canvas);			
		}

		/*
		 * If WebGL is unsupported we switch to a canvas renderer
		 */
		this.renderer 			= Detector.webgl ? new THREE.WebGLRenderer({antialias:true}) : new THREE.CanvasRenderer();
				
		this.renderer.setSize(this.width, this.height);

		this.renderer.shadowMapEnabled = true;		

		this.material 			= new THREE.MeshBasicMaterial({color: this.color });
		this.recordingMaterial 	= new THREE.MeshBasicMaterial({color: this.gestureColor });
		
		this.palmGeometry		= new THREE.CubeGeometry(60, 10, 60);
		this.fingerGeometry 	= Detector.webgl ? new THREE.SphereGeometry(5, 20, 10) : new THREE.TorusGeometry(1, 5, 5, 5);

		this.scene 				= new THREE.Scene();

		/*
		 * A spotlight casts a shadow of the hand onto a transparent plane behind
		 */
		this.light    = new THREE.SpotLight();
		
		this.light.castShadow = true;

		this.scene.add(this.light);
		
		/*
		 * The camera is created and set to its initial position
		 */
		this.camera = new THREE.PerspectiveCamera(45, 1, 1, 3000);

		/*
		 * The renderer is added to the rendering area in the DOM.
		 */
		this.canvas.appendChild(this.renderer.domElement);
		
		/*
		 * An inital pair of palm meshs and ten this.fingers are added to the scene. The second palm and second five this.fingers 
		 * are initially invisible.  The first palm and this.fingers are set in a default pose below.
		 * 
		 * NOTE: Currently only one hand is supported.
		 */
		this.palms = [this.createPalm(), this.createPalm()];

		this.palms[1].visible = false;

		this.scene.add(this.palms[0]);
		this.scene.add(this.palms[1]);

		var finger; 
		
		this.fingers = [];
		
		for (var j = 0; j < 10; j++) { 

			finger = this.createFinger();
			
			finger.visible = j < 5;
			
			this.scene.add(finger);

			this.fingers.push(finger); // Finger meshes are stored for animation below
		}

		/*
		 * 
		 */
		this.createShadowPlane();

		/*
		 * We set default a default pose for the one visible (right) hand
		 */
		this.setDefaultPosition();

		/*
		 * A window resize listener ensures the canvas default position remains correct relative to a changing window size. 
		 */
		if (window.addEventListener) { window.addEventListener('resize', this.setDefaultPosition.bind(this), false); 

		} else if (elem.attachEvent) { window.attachEvent("onResize", this.setDefaultPosition.bind(this)); }		
		
		/*
		 * If a trainer is available we set the gesture material to be used during recording.
		 */
		if (this.trainerEnabled) {

			this.controller.on('started-recording', function () { this.setHandMaterial(this.recordingMaterial); }.bind(this))
	   					   .on('stopped-recording', function () { this.setHandMaterial(this.material); }.bind(this));
		}

		/*
		 * We use Paul Irish's requestAnimFrame function (which is described 
		 * here: http://www.paulirish.com/2011/requestanimationframe-for-smart-animating/) for 
		 * updating the scene.
		 * 	
		 */
		window.requestAnimFrame = (function(){
			  return  window.requestAnimationFrame       ||
			          window.webkitRequestAnimationFrame ||
			          window.mozRequestAnimationFrame    ||
			          function(callback){ window.setTimeout(callback, 1000 / 60); };
			})();
		
		requestAnimFrame(this.updateRender.bind(this));

		/*
		 * In order to avoid as much variable creation as possible during animation, variables are created here once.
		 */
		var hand, palm, handFingers, handFingerCount, finger, handCount, palmCount = this.palms.length;	

		/*
		 * Now we set up a Leap controller frame listener in order to animate the scene
		 */
		var clock = new THREE.Clock();
		
		clock.previousTime = 1000000;	

		this.evtController.on('frame', function(frame) {

			if (clock.previousTime === 1000000) {
				
				this.scroll(frame);

				handCount = frame.hands.length;
				
				if (handCount > 0) {

					hand = frame.hands[0];

					var top		= (-hand.stabilizedPalmPosition[1] * 3) + (window.innerHeight);
					var left	= (hand.stabilizedPalmPosition[0] * 3) + (window.innerWidth/2);

					this.canvas.style.top = top + 'px';
					this.canvas.style.left = left + 'px';

				} else {
					
					if (!this.defaultHandPosition) { this.setDefaultPosition(); }

					return;
				}
				
				for (var i = 0; i < /*palmCount*/1; i++) { // NOTE: Currently we don't attempt to render the second hand
					
					palm = this.palms[i];

					if (i >= handCount) {
					
						if (!this.defaultHandPosition) { // If the default pose is showing we don't update anything

							palm.visible = false;

							for (var j = 0, k = 5, p; j < k; j++) { p = (i * 5) + j; this.fingers[p].visible = false; };						
						}

					} else {
						
						this.defaultHandPosition = false;
						
						hand = frame.hands[i];

						this.positionPalm(hand, palm);
						
						palm.visible = true;

						handFingers 	= hand.fingers;
						handFingerCount = handFingers.length;

						/*
						 * 
						 */
						for (var j = 0, k = 5; j < k; j++) {
							
							finger = this.fingers[(i * 5) + j];

							if (j >= handFingerCount) {
								
								finger.visible = false;
								
							} else {

								this.positionFinger(handFingers[j], finger, palm);
								
								finger.visible = true;
							}
						};
					}
				}	
			}

		}.bind(this));		
	},
	
	/*
	 * We bind a simple update function into the requestAnimFrame function
	 */
	updateRender: function () { this.renderer.render(this.scene, this.camera); requestAnimFrame(this.updateRender.bind(this)); },
	
	/*
	 * Creates a palm mesh
	 */
	createPalm: function () { var palm = new THREE.Mesh(this.palmGeometry, this.material); palm.castShadow = true; palm.receiveShadow = true; return palm; },
	
	/*
	 * Creates a finger mesh
	 */
	createFinger: function () { var finger = new THREE.Mesh(this.fingerGeometry, this.material); finger.castShadow = true; finger.receiveShadow = true; return finger; },
	
	/*
	 * Creates a transparent plane onto which hand shadows are cast.
	 */
	createShadowPlane: function () { 
		
		/*
		 * A shader is used to set the obscured areas to a shadow color, while leaving the rest of the plane transparent.
		 */
        var planeFragmentShader = [

           "uniform vec3 diffuse;",
           "uniform float opacity;",

           THREE.ShaderChunk[ "color_pars_fragment" ],
           THREE.ShaderChunk[ "map_pars_fragment" ],
           THREE.ShaderChunk[ "lightmap_pars_fragment" ],
           THREE.ShaderChunk[ "envmap_pars_fragment" ],
           THREE.ShaderChunk[ "fog_pars_fragment" ],
           THREE.ShaderChunk[ "shadowmap_pars_fragment" ],
           THREE.ShaderChunk[ "specularmap_pars_fragment" ],

           "void main() {",

               "gl_FragColor = vec4( 1.0, 1.0, 1.0, 1.0 );",

               THREE.ShaderChunk[ "map_fragment" ],
               THREE.ShaderChunk[ "alphatest_fragment" ],
               THREE.ShaderChunk[ "specularmap_fragment" ],
               THREE.ShaderChunk[ "lightmap_fragment" ],
               THREE.ShaderChunk[ "color_fragment" ],
               THREE.ShaderChunk[ "envmap_fragment" ],
               THREE.ShaderChunk[ "shadowmap_fragment" ],
               THREE.ShaderChunk[ "linear_to_gamma_fragment" ],
               THREE.ShaderChunk[ "fog_fragment" ],

               "gl_FragColor = vec4( 0.0, 0.0, 0.0, min(0.1, 1.0 - shadowColor.x) );",

           "}"

       ].join("\n");

       var planeMaterial = new THREE.ShaderMaterial({
           uniforms			: THREE.ShaderLib['basic'].uniforms,
           vertexShader		: THREE.ShaderLib['basic'].vertexShader,
           fragmentShader	: planeFragmentShader,
           color: 0x0000FF
       });

       this.shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(this.width * 4, this.height * 4, 50), planeMaterial);

       this.shadowPlane.receiveShadow = true;
       
       this.scene.add(this.shadowPlane);
	},
	
	/*
	 * This function returns the canvas, the palms, and the fingers to their original positions.
	 */
	setDefaultPosition: function() {

		this.canvas.style.top = ((this.top) ? this.top : window.innerHeight - this.height - 20) + 'px';
		this.canvas.style.left = ((this.left) ? this.left : window.innerWidth - this.width - 20) + 'px';		
		
		if (this.defaultHandPosition) { return; }
		
		this.defaultHandPosition = true;

		this.camera.position.set(0, 0, 350);
		this.shadowPlane.position.set(0, 0, -25);
		this.light.position.set(0, 0, 650);
		this.light.lookAt(this.shadowPlane);

		this.palms[0].position.set(25.62994, -37.67400000000001, 96.368);
		this.palms[0].rotation.set(-1.9921488149553125, 0.051271951412566935, -2.6597446090413466);

		this.fingers[0].position.set(64.179, 24.22, 28.7022);
		this.fingers[0].rotation.set(-2.677879785829599, 0.02183472660404244, 3.133282166633954);
		this.fingers[0].scale.z = 8;
		this.fingers[0].visible = true;
		
		this.fingers[1].position.set(83.8033, -15.913000000000011, 32.6661);
		this.fingers[1].rotation.set(-2.6753644328170965, 0.22532594370921782, 3.056111568660471);
		this.fingers[1].scale.z = 5;
		this.fingers[1].visible = true;
		
		this.fingers[2].position.set(34.69965, 49.19499999999999, 31.643);
		this.fingers[2].rotation.set(-2.500622653205929, 0.033504548426940645, 3.121471314695975);
		this.fingers[2].scale.z = 9;
		this.fingers[2].visible = true;

		this.fingers[3].position.set(8.7075, 50.976, 50.363);
		this.fingers[3].rotation.set(-2.443443897235925, 0.04106473211751575, 3.113625377842598);
		this.fingers[3].scale.z = 8;
		this.fingers[3].visible = true;
		
		this.fingers[4].position.set(-40.6532, -33.772999999999996, 84.7031);
		this.fingers[4].rotation.set(-2.489002343898949, -0.4631619960981157, -2.872745378807403);
		this.fingers[4].scale.z = 6;
		this.fingers[4].visible = true;
	},
	
	/*
	 * Updates the material of the palm and this.fingers created above.  This function is called when recording starts and ends, in order to 
	 * modify how visible hands look during recording.
	 */
	setHandMaterial: function (m) {
		
		this.palms[0].material = m;
		this.palms[1].material = m;
		
		for (var i = 0, l = this.fingers.length; i < l; i++) { this.fingers[i].material = m; }		
	},
	
	/*
	 * The palm is moved into position as determined by input from the Leap.  
	 * 
	 * The camera, shadow plane, and light are also moved. 
	 * 
	 * The positionPalm and positionFinger functions come from LeapTrainer, but are originally based on code 
	 * from jestPlay (also under the MIT license), by Theo Armour:
	 * 
	 * 	http://jaanga.github.io/gestification/cookbook/jest-play/r1/jest-play.html
	 * 
	 * Thanks Theo!
	 */
	positionPalm: function (hand, palm) {

		var position = hand.stabilizedPalmPosition;

		palm.position.set(position[0], position[1] + this.yOffset, palm.position.z); 	
		
		this.camera.position.x = this.shadowPlane.position.x = palm.position.x;
		this.camera.position.y = this.shadowPlane.position.y = palm.position.y;

		this.light.position.x = position[0];
		this.light.position.y = position[1];
		
		var direction = hand.direction;
		
		palm.lookAt(new THREE.Vector3(direction[0], direction[1], direction[2]).add(palm.position));

		var normal = hand.palmNormal;
		
		palm.rotation.z = Math.atan2(normal[0], normal[1]);
	},
	
	/*
	 * 
	 */
	positionFinger: function (handFinger, finger, palm) {

		var position = handFinger.stabilizedTipPosition;

		finger.position.set(position[0], position[1] + this.yOffset, position[2]);
		
		var direction = handFinger.direction;
		
		finger.lookAt(new THREE.Vector3(direction[0], direction[1], direction[2]).add(finger.position));

		finger.scale.z = 0.1 * handFinger.length;
	},
	
	/*
	 * Updates the target scroll position 
	 */
	scroll: function(frame) {

		if(!this.lastFrame) { this.lastFrame = frame; return; }
		
		var hands = frame.hands;

		if(hands.length == 0) {

	    	this.speed[0]  *= this.dampening;
	    	this.speed[1]  *= this.dampening;
	    	this.speed[2]  *= this.dampening;					
			
	    	this.lastFrame = null; 

		} else if(hands.length == 1) {

			var velocity = frame.translation(this.lastFrame);

			this.speed[0] = this.scrollSpeed * velocity[0];
			this.speed[1] = this.scrollSpeed * velocity[1];
			this.speed[2] = this.scrollSpeed * velocity[2];
		}

		if (Math.abs(this.speed[0] + this.speed[1] + this.speed[2]) > 3) {

			var doc = document.documentElement, body = document.body;

			var left = (doc && doc.scrollLeft || body && body.scrollLeft || 0);
			var top = (doc && doc.scrollTop  || body && body.scrollTop  || 0);		

			var target = this.target;
			
			if (target == window) {

				top = (doc && doc.scrollTop  || body && body.scrollTop  || 0);
				left = (doc && doc.scrollLeft || body && body.scrollLeft || 0);
			
			} else {
				
				top = target.scrollTop || 0;
				left = target.scrollLeft || 0;
			}

			target.scrollTo(left + this.speed[0], top - this.speed[1]);
		}
	}
};

/**
 * Here we parse parameters to the script include in order to pass them as options to the LeapCursor constructor below.
 * 
 * @param query
 * @returns {Object}
 */
function parseQuery (query) {

	var parameters = new Object ();

	if (!query) return parameters; // return empty object

	var pairs = query.split(/[;&]/);

	for ( var i = 0; i < pairs.length; i++ ) {

		var KeyVal = pairs[i].split('=');

		if ( ! KeyVal || KeyVal.length != 2 ) continue;

		var key = unescape( KeyVal[0] );
		var val = unescape( KeyVal[1] );

		val = val.replace(/\+/g, ' ');

		parameters[key] = val;
	}

	return parameters;		
}

var scripts = document.getElementsByTagName('script');

var params = this.parseQuery(scripts[scripts.length - 1].src.replace(/^[^\?]+\??/,''));

/**
 * 
 */
if (window.addEventListener) { window.addEventListener('load', function() { window.leapCursor = new LeapCursor(params); }, false); 

} else if (elem.attachEvent) { window.attachEvent("onLoad", function() { window.leapCursor = new LeapCursor(params); }); }