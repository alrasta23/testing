"use strict";

const heartRateMonitor = (function () {
	// Size of sampling image
	const IMAGE_WIDTH = 30;
	const IMAGE_HEIGHT = 30;

	// Array of measured samples
	const SAMPLE_BUFFER = [];

	// Max 5 seconds of samples (at 60 samples per second)
	// Measurement isn't dependant on frame rate but the visual speed of the graph is
	const MAX_SAMPLES = 60 * 5;

	// How long to wait in milliseconds for the camera image to stabilize before starting measurement
	const START_DELAY = 1500;

	// Callback for reporting the measured heart rate
	let ON_BPM_CHANGE;

	// Callback for reporting the measured heart rate
	let ON_BPM_STATUS_CHANGE;

	// The <video> element for streaming the camera feed into
	let VIDEO_ELEMENT;

	// Canvas element for sampling image data from the video stream
	let SAMPLING_CANVAS;

	// Sampling canvas 2d context
	let SAMPLING_CONTEXT;

	// Canvas element for the graph
	let GRAPH_CANVAS;

	// Graph canvas 2d context
	let GRAPH_CONTEXT;

	// Color of the graph line
	let GRAPH_COLOR;

	// Width of the graph line
	let GRAPH_WIDTH;

	// Whether to print debug messages
	let DEBUG = false;

	// Video stream object
	let VIDEO_STREAM;

	let MONITORING = false;

	// Debug logging
	const log = (...args) => {
		if (DEBUG) {
			console.log(...args);
			document.querySelector("#debug-log").innerHTML += args + "<br />";
		}
	};

	// Publicly available methods & variables
	const publicMethods = {};

	// Get an average brightness reading
	const averageBrightness = (canvas, context) => {
		// 1d array of r, g, b, a pixel data values
		const pixelData = context.getImageData(
			0,
			0,
			canvas.width,
			canvas.height
		).data;
		let sum = 0;

		// Only use the red and green channels as that combination gives the best readings
		for (let i = 0; i < pixelData.length; i += 4) {
			sum = sum + pixelData[i] + pixelData[i + 1];
		}

		// Since we only process two channels out of four we scale the data length to half
		const avg = sum / (pixelData.length * 0.5);

		// Scale to 0 ... 1
		return avg / 255;
	};

	publicMethods.initialize = (configuration) => {
		VIDEO_ELEMENT = configuration.videoElement;
		SAMPLING_CANVAS = configuration.samplingCanvas;
		GRAPH_CANVAS = configuration.graphCanvas;
		GRAPH_COLOR = configuration.graphColor;
		GRAPH_WIDTH = configuration.graphWidth;
		ON_BPM_CHANGE = configuration.onBpmChange;
		ON_BPM_STATUS_CHANGE = configuration.onBpmStatusChange;

		SAMPLING_CONTEXT = SAMPLING_CANVAS.getContext("2d");
		GRAPH_CONTEXT = GRAPH_CANVAS.getContext("2d");

		if (!"mediaDevices" in navigator) {
			// TODO: use something nicer than an alert
			alert(
				"Sorry, your browser doesn't support camera access which is required by this app."
			);
			return false;
		}

		// Setup event listeners
		window.addEventListener("resize", handleResize);

		// Set the canvas size to its element size
		handleResize();
	};

	const handleResize = () => {
		log(
			"handleResize",
			GRAPH_CANVAS.clientWidth,
			GRAPH_CANVAS.clientHeight
		);
		GRAPH_CANVAS.width = GRAPH_CANVAS.clientWidth;
		GRAPH_CANVAS.height = GRAPH_CANVAS.clientHeight;
	};

	publicMethods.toggleMonitoring = () => {
		MONITORING ? stopMonitoring() : startMonitoring();
	};

	const getCamera = async () => {
		const devices = await navigator.mediaDevices.enumerateDevices();
		const cameras = devices.filter(
			(device) => device.kind === "videoinput"
		);
		return cameras[cameras.length - 1];
	};

	const startMonitoring = async () => {
		resetBuffer();
		handleResize();
		setBpmDisplay("");
		setBpmStatusDisplay("Started");

		const camera = await getCamera();
		VIDEO_STREAM = await startCameraStream(camera);

		if (!VIDEO_STREAM) {
			throw Error("Unable to start video stream");
		}

		try {
			setTorchStatus(VIDEO_STREAM, true);
		} catch (e) {
			alert("Error:" + e);
		}

		SAMPLING_CANVAS.width = IMAGE_WIDTH;
		SAMPLING_CANVAS.height = IMAGE_HEIGHT;
		VIDEO_ELEMENT.srcObject = VIDEO_STREAM;
		VIDEO_ELEMENT.play();
		MONITORING = true;

		// Waiting helps stabilaze the camera image before taking samples
		log("Waiting before starting mainloop...");
		setTimeout(async () => {
			log("Starting mainloop...");
			monitorLoop();
		}, START_DELAY);
	};

	const stopMonitoring = async () => {
		setTorchStatus(VIDEO_STREAM, false);
		VIDEO_ELEMENT.pause();
		VIDEO_ELEMENT.srcObject = null;
		MONITORING = false;
	};

	const monitorLoop = () => {
		processFrame();
		if (MONITORING) {
			window.requestAnimationFrame(monitorLoop);
		}
	};

	const resetBuffer = () => {
		SAMPLE_BUFFER.length = 0;
	};

	const startCameraStream = async (camera) => {
		// At this point the browser asks for permission
		let stream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				video: {
					deviceId: camera.deviceId,
					facingMode: ["user", "environment"],
					width: { ideal: IMAGE_WIDTH },
					height: { ideal: IMAGE_HEIGHT },

					// Experimental:
					whiteBalanceMode: "manual",
					exposureMode: "manual",
					focusMode: "manual",
				},
			});
		} catch (error) {
			alert("Failed to access camera!\nError: " + error.message);
			return;
		}

		return stream;
	};

	const setTorchStatus = async (stream, status) => {
		// Try to enable flashlight
		try {
			const track = stream.getVideoTracks()[0];
			await track.applyConstraints({
				advanced: [{ torch: status }],
			});
		} catch (error) {
			alert("Starting torch failed.\nError: " + error.message);
		}
	};

	const setBpmDisplay = (bpm) => {
		ON_BPM_CHANGE(bpm);
	};

	const setBpmStatusDisplay = (bpmStatus) => {
		ON_BPM_STATUS_CHANGE(bpmStatus);
	};

	const calculateHistogram = (canvas, context) => {
		const pixelData = context.getImageData(
			0,
			0,
			canvas.width,
			canvas.height
		).data;
		const histogram = new Array(256).fill(0);

		for (let i = 0; i < pixelData.length; i += 4) {
			const r = pixelData[i];
			const g = pixelData[i + 1];
			const b = pixelData[i + 2];
			const grayscale = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
			histogram[grayscale]++;
		}

		return histogram;
	};

	const isFingerOnCameraSophisticated = (histogram) => {
		const totalPixels = histogram.reduce((sum, count) => sum + count, 0);
		const darkPixelThreshold = totalPixels * 0.75; // Threshold for dark pixels
		const lightPixelThreshold = totalPixels * 0.1; // Threshold for light pixels

		const darkPixelCount = histogram
			.slice(0, 50)
			.reduce((sum, count) => sum + count, 0);
		const lightPixelCount = histogram
			.slice(200, 256)
			.reduce((sum, count) => sum + count, 0);

		// console.log("Dark: " + darkPixelCount);
		// console.log("Light: " + lightPixelCount);

		// setBpmStatusDisplay(
		// 	"Dark: " + darkPixelCount + "Light: " + lightPixelCount
		// );
		// Check if the dark pixel count is high and light pixel count is low
		return lightPixelCount <= 20;
	};

	const calculateVariance = (canvas, context) => {
		const pixelData = context.getImageData(
			0,
			0,
			canvas.width,
			canvas.height
		).data;
		const grayscaleValues = [];

		for (let i = 0; i < pixelData.length; i += 4) {
			const r = pixelData[i];
			const g = pixelData[i + 1];
			const b = pixelData[i + 2];
			const grayscale = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
			grayscaleValues.push(grayscale);
		}

		const mean =
			grayscaleValues.reduce((sum, val) => sum + val, 0) /
			grayscaleValues.length;
		const variance =
			grayscaleValues.reduce(
				(sum, val) => sum + Math.pow(val - mean, 2),
				0
			) / grayscaleValues.length;

		return variance;
	};

	const isFingerOnCameraVariance = (variance) => {
		//setBpmStatusDisplay("Variance: " + variance);
		const threshold = 300; // Adjust threshold based on testing and environment
		return variance < threshold;
	};

	const processFrame = () => {
		// Draw the current video frame onto the canvas
		SAMPLING_CONTEXT.drawImage(
			VIDEO_ELEMENT,
			0,
			0,
			IMAGE_WIDTH,
			IMAGE_HEIGHT
		);

		// Calculate the variance of pixel intensities
		const variance = calculateVariance(SAMPLING_CANVAS, SAMPLING_CONTEXT);

		// Calculate the histogram of pixel intensities
		const histogram = calculateHistogram(SAMPLING_CANVAS, SAMPLING_CONTEXT);

		if (
			isFingerOnCameraVariance(variance) &&
			isFingerOnCameraSophisticated(histogram)
		) {
			//setBpmStatusDisplay("Finger detected");
		} else {
			setBpmStatusDisplay("Please place your finger on the camera");
			return;
		}

		// Get a sample from the canvas pixels
		const value = averageBrightness(SAMPLING_CANVAS, SAMPLING_CONTEXT);
		const time = Date.now();

		SAMPLE_BUFFER.push({ value, time });
		if (SAMPLE_BUFFER.length > MAX_SAMPLES) {
			SAMPLE_BUFFER.shift();
		}

		const dataStats = analyzeData(SAMPLE_BUFFER);

		//console.log(dataStats.crossings);
		//[{value: 0.3704030501089325, time: 1718981771434}, {value: 0.3682374727668845, time: 1718981772451}, {value: 0.3691263616557734, time: 1718981773351}, {value: 0.3702832244008714, time: 1718981774251}, {value: 0.36861437908496736, time: 1718981775184}] (5)

		const bpm = calculateBpm(dataStats.crossings);

		// TODO: Store BPM values in array and display moving average
		if (bpm) {
			setBpmDisplay(Math.round(bpm));
		}
		drawGraph(dataStats);
	};

	const analyzeData = (samples) => {
		// Get the mean average value of the samples
		const average =
			samples.map((sample) => sample.value).reduce((a, c) => a + c) /
			samples.length;

		// Find the lowest and highest sample values in the data
		// Used for both calculating bpm and fitting the graph in the canvas
		let min = samples[0].value;
		let max = samples[0].value;
		samples.forEach((sample) => {
			if (sample.value > max) {
				max = sample.value;
			}
			if (sample.value < min) {
				min = sample.value;
			}
		});

		// The range of the change in values
		// For a good measurement it should be between  ~ 0.002 - 0.02
		const range = max - min;

		const crossings = getAverageCrossings(samples, average);
		return {
			average,
			min,
			max,
			range,
			crossings,
		};
	};

	const getAverageCrossings = (samples, average) => {
		// Get each sample at points where the graph has crossed below the average level
		// These are visible as the rising edges that pass the midpoint of the graph
		const crossingsSamples = [];
		let previousSample = samples[0]; // Avoid if statement in loop

		samples.forEach(function (currentSample) {
			// Check if next sample has gone below average.
			if (
				currentSample.value < average &&
				previousSample.value > average
			) {
				crossingsSamples.push(currentSample);
			}

			previousSample = currentSample;
		});

		return crossingsSamples;
	};

	let rrIntervals = [];
	let rrIntervalLast = 0;
	let rrIntervalsLast10 = [];
	let avg20Intervals = 0;
	let captureTime = Date.now();

	const calculateBpm = (samples) => {
		if (samples.length < 3) {
			setBpmDisplay("");
			setBpmStatusDisplay("Calibrating");
			return;
		}

		const averageInterval =
			(samples[samples.length - 1].time - samples[0].time) /
			(samples.length - 1);

		const rrInt = samples[samples.length - 1].time - samples[0].time;
		//console.log(samples.length);
		const rrIntLast = samples[1].time - samples[0].time;
		const rrIntFirst =
			samples[samples.length - 1].time - samples[samples.length - 2].time;

		//Find a baseline RR Interval and only accept those that are close to baseline
		// return samples.length;
		if (samples.length >= 3 && rrIntFirst < 2000 && rrIntFirst > 250) {
			if (rrIntervalLast != rrIntFirst) {
				rrIntervalLast = rrIntFirst;
				// console.log(rrIntervals.length);
				if (rrIntervals.length == 50) {
					const metrics = calculateMetrics(rrIntervals);
					// Convert the metrics to a JSON string
					const metricsString = JSON.stringify(metrics, null, 2);
					alert(metricsString);
				}
				if (rrIntervalsLast10.length >= 20) {
					rrIntervalsLast10.shift();
					let totIntervals = 0;
					rrIntervalsLast10.forEach((interval) => {
						totIntervals = totIntervals + interval;
					});
					avg20Intervals = totIntervals / 20;
				}
				rrIntervalsLast10.push(rrIntervalLast);

				let timeElapsed = Date.now() - captureTime;
				if (
					Math.abs(rrIntervalLast - avg20Intervals) < 150 &&
					timeElapsed > avg20Intervals / 2
				) {
					rrIntervals.push(rrIntervalLast);
					captureTime = Date.now();

					let numCurrentIntervals = rrIntervals.length;
					setBpmStatusDisplay(numCurrentIntervals + "/50");
					console.log(rrIntervals);
				}
			}
			if (avg20Intervals > 0) {
				return 60000 / avg20Intervals;
			}
		}
		// return -1;
		// return 60000 / averageInterval;
	};
	// Helper function to pad array to the next power of two
	function padArrayToNextPowerOfTwo(arr) {
		const nextPowerOfTwo = Math.pow(2, Math.ceil(Math.log2(arr.length)));
		const paddedArray = new Array(nextPowerOfTwo).fill(0);
		for (let i = 0; i < arr.length; i++) {
			paddedArray[i] = arr[i];
		}
		return paddedArray;
	}

	// Simplified FFT implementation
	function fft(arr) {
		const N = arr.length;
		if (N <= 1) return arr;

		const even = fft(arr.filter((_, i) => i % 2 === 0));
		const odd = fft(arr.filter((_, i) => i % 2 !== 0));

		const T = [...Array(N / 2)].map((_, k) => {
			const exp = (-2 * Math.PI * k) / N;
			return [Math.cos(exp), Math.sin(exp)];
		});

		return [...Array(N)].map((_, k) => {
			const [cos, sin] = T[k % (N / 2)];
			const term = [
				cos * odd[k % (N / 2)][0] - sin * odd[k % (N / 2)][1],
				cos * odd[k % (N / 2)][1] + sin * odd[k % (N / 2)][0],
			];
			return k < N / 2
				? [even[k][0] + term[0], even[k][1] + term[1]]
				: [even[k - N / 2][0] - term[0], even[k - N / 2][1] - term[1]];
		});
	}

	// Calculate Power Spectral Density (PSD)
	function calculatePSD(rrIntervals) {
		const paddedRR = padArrayToNextPowerOfTwo(rrIntervals);
		const N = paddedRR.length;
		const mean = paddedRR.reduce((acc, val) => acc + val, 0) / N;
		const centeredRR = paddedRR.map((val) => val - mean);

		const fftResult = fft(centeredRR.map((val) => [val, 0]));

		return fftResult.slice(0, N / 2).map(([re, im], i) => {
			const freq = i / (N / 2);
			const power = (re ** 2 + im ** 2) / N;
			return { freq, power };
		});
	}

	// Calculate LF and HF power
	function calculateLFHF(rrIntervals) {
		const psd = calculatePSD(rrIntervals);

		const lfPower = psd
			.filter(({ freq }) => freq >= 0.04 && freq < 0.15)
			.reduce((acc, { power }) => acc + power, 0);
		const hfPower = psd
			.filter(({ freq }) => freq >= 0.15 && freq < 0.4)
			.reduce((acc, { power }) => acc + power, 0);

		return { lfPower, hfPower };
	}

	// Helper functions for other metrics
	function calculateRMSSD(rrIntervals) {
		const diffRR = rrIntervals.slice(1).map((rr, i) => rr - rrIntervals[i]);
		const squaredDiffs = diffRR.map((diff) => Math.pow(diff, 2));
		const meanSquaredDiffs =
			squaredDiffs.reduce((acc, curr) => acc + curr, 0) /
			squaredDiffs.length;
		return Math.sqrt(meanSquaredDiffs);
	}

	function calculateMeanRR(rrIntervals) {
		return (
			rrIntervals.reduce((acc, curr) => acc + curr, 0) /
			rrIntervals.length
		);
	}

	function calculatePNN50(rrIntervals) {
		const diffRR = rrIntervals
			.slice(1)
			.map((rr, i) => Math.abs(rr - rrIntervals[i]));
		const nn50 = diffRR.filter((diff) => diff > 50).length;
		return (nn50 / (rrIntervals.length - 1)) * 100;
	}

	function calculateEnergy(rmssd) {
		return 1000 / rmssd;
	}

	function calculateStress(lfPower, hfPower) {
		return lfPower / hfPower;
	}

	function calculateTension(rmssd, meanRR) {
		return (1000 / rmssd) * (1000 / meanRR);
	}

	// Main function to calculate all metrics
	function calculateMetrics(rrIntervals) {
		const rmssd = calculateRMSSD(rrIntervals);
		const meanRR = calculateMeanRR(rrIntervals);
		const { lfPower, hfPower } = calculateLFHF(rrIntervals);

		const energy = calculateEnergy(rmssd);
		const stress = calculateStress(lfPower, hfPower);
		const tension = calculateTension(rmssd, meanRR);
		const pnn50 = calculatePNN50(rrIntervals);

		return {
			rmssd,
			meanRR,
			lfPower,
			hfPower,
			energy,
			stress,
			tension,
			pnn50,
		};
	}

	const drawGraph = (dataStats) => {
		// Scaling of sample window to the graph width
		const xScaling = GRAPH_CANVAS.width / MAX_SAMPLES;

		// Set offset based on number of samples, so the graph runs from the right edge to the left
		const xOffset = (MAX_SAMPLES - SAMPLE_BUFFER.length) * xScaling;

		GRAPH_CONTEXT.lineWidth = GRAPH_WIDTH;
		GRAPH_CONTEXT.strokeStyle = GRAPH_COLOR;
		GRAPH_CONTEXT.lineCap = "round";
		GRAPH_CONTEXT.lineJoin = "round";

		GRAPH_CONTEXT.clearRect(0, 0, GRAPH_CANVAS.width, GRAPH_CANVAS.height);
		GRAPH_CONTEXT.beginPath();

		// Avoid drawing too close to the graph edges due to the line thickness getting cut off
		const maxHeight = GRAPH_CANVAS.height - GRAPH_CONTEXT.lineWidth * 2;
		let previousY = 0;
		SAMPLE_BUFFER.forEach((sample, i) => {
			const x = xScaling * i + xOffset;

			let y = GRAPH_CONTEXT.lineWidth;

			if (sample.value !== 0) {
				y =
					(maxHeight * (sample.value - dataStats.min)) /
						(dataStats.max - dataStats.min) +
					GRAPH_CONTEXT.lineWidth;
			}

			if (y != previousY) {
				GRAPH_CONTEXT.lineTo(x, y);
			}

			previousY = y;
		});

		GRAPH_CONTEXT.stroke();
	};

	return publicMethods;
})();
