/**
 * Image Processing Web Worker
 * ES6 Module Worker for image palletization
 * Handles processing without blocking the main thread
 */

import {
  ImageToSVGPalletizer,
  EnhancedImageToSVGPalletizer,
  StructureAwareImagePalletizer,
  PosterizeImagePalletizer
} from './palletizers.js';

// Message handler
self.addEventListener('message', async (e) => {
  const { type, payload } = e.data;

  switch (type) {
    case 'PROCESS_IMAGE':
      await processImage(payload);
      break;

    default:
      console.warn('Unknown message type:', type);
  }
});

async function processImage({ imageData, width, height, difficulty, processor = 'structure-aware' }) {
  try {
    console.log('Worker received processor:', processor, 'difficulty:', difficulty);

    self.postMessage({
      type: 'PROGRESS',
      payload: { status: 'Starting processing...', progress: 0 }
    });

    // Handle Segment Anything (SAM) processor - calls backend service
    if (processor === 'segment-anything') {
      await processSAM(imageData, width, height, difficulty);
      return;
    }

    // Create ImageBitmap from ImageData
    const imageBitmap = await createImageBitmap(
      new ImageData(new Uint8ClampedArray(imageData), width, height)
    );

    self.postMessage({
      type: 'PROGRESS',
      payload: { status: 'Initializing palletizer...', progress: 5 }
    });

    // Create palletizer instance based on processor type
    let palletizer;
    console.log('Creating palletizer for processor:', processor);
    if (processor === 'structure-aware') {
      palletizer = new StructureAwareImagePalletizer({ difficulty });
    } else if (processor === 'region-growing') {
      // Map difficulty to region-growing parameters
      const difficultyMap = {
        easy: { K: 12 },
        medium: { K: 20 },
        hard: { K: 30 },
        expert: { K: 40 }
      };
      const params = difficultyMap[difficulty] || { K: 20 };
      palletizer = new EnhancedImageToSVGPalletizer(params);
    } else if (processor === 'kmeans') {
      // Map difficulty to kmeans parameters
      const difficultyMap = {
        easy: { K: 12 },
        medium: { K: 20 },
        hard: { K: 30 },
        expert: { K: 40 }
      };
      const params = difficultyMap[difficulty] || { K: 20 };
      palletizer = new ImageToSVGPalletizer({ ...params, algorithm: 'kmeans' });
    } else if (processor === 'posterize') {
      // Map difficulty to posterize parameters
      const difficultyMap = {
        easy: { numColors: 12 },
        medium: { numColors: 16 },
        hard: { numColors: 24 },
        expert: { numColors: 32 }
      };
      const params = difficultyMap[difficulty] || { numColors: 16 };
      palletizer = new PosterizeImagePalletizer({ ...params, difficulty });
    } else {
      throw new Error(`Unknown processor type: ${processor}`);
    }

    // Hook into internal processing steps for progress updates
    const originalBilateralFilter = palletizer._bilateralFilter;
    if (originalBilateralFilter) {
      palletizer._bilateralFilter = function(...args) {
        self.postMessage({
          type: 'PROGRESS',
          payload: { status: 'Applying bilateral filter...', progress: 15 }
        });
        return originalBilateralFilter.apply(this, args);
      };
    }

    const originalSlicSegmentation = palletizer._slicSegmentation;
    if (originalSlicSegmentation) {
      palletizer._slicSegmentation = function(...args) {
        self.postMessage({
          type: 'PROGRESS',
          payload: { status: 'Computing superpixels...', progress: 30 }
        });
        return originalSlicSegmentation.apply(this, args);
      };
    }

    const originalComputeRegionColors = palletizer._computeRegionColors;
    if (originalComputeRegionColors) {
      palletizer._computeRegionColors = function(...args) {
        self.postMessage({
          type: 'PROGRESS',
          payload: { status: 'Computing region colors...', progress: 45 }
        });
        return originalComputeRegionColors.apply(this, args);
      };
    }

    const originalMergeRegions = palletizer._mergeRegions;
    if (originalMergeRegions) {
      palletizer._mergeRegions = function(...args) {
        self.postMessage({
          type: 'PROGRESS',
          payload: { status: 'Merging similar regions...', progress: 60 }
        });
        return originalMergeRegions.apply(this, args);
      };
    }

    const originalExtractContours = palletizer._extractContours;
    if (originalExtractContours) {
      palletizer._extractContours = function(...args) {
        self.postMessage({
          type: 'PROGRESS',
          payload: { status: 'Extracting contours...', progress: 75 }
        });
        return originalExtractContours.apply(this, args);
      };
    }

    const originalQuantizeRegionColors = palletizer._quantizeRegionColorsWithMap;
    if (originalQuantizeRegionColors) {
      palletizer._quantizeRegionColorsWithMap = function(...args) {
        self.postMessage({
          type: 'PROGRESS',
          payload: { status: 'Quantizing colors...', progress: 85 }
        });
        return originalQuantizeRegionColors.apply(this, args);
      };
    }

    // Process the image
    self.postMessage({
      type: 'PROGRESS',
      payload: { status: 'Processing image...', progress: 10 }
    });

    const { svg } = await palletizer.process(imageBitmap);

    self.postMessage({
      type: 'PROGRESS',
      payload: { status: 'Complete!', progress: 100 }
    });

    // Send result back
    self.postMessage({
      type: 'COMPLETE',
      payload: {
        svg,
        difficulty
      }
    });

  } catch (error) {
    self.postMessage({
      type: 'ERROR',
      payload: {
        message: error.message,
        stack: error.stack
      }
    });
  }
}

async function processSAM(imageData, width, height, difficulty) {
  try {
    self.postMessage({
      type: 'PROGRESS',
      payload: { status: 'Converting image to blob...', progress: 10 }
    });

    // Convert ImageData to blob
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(imageData), width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });

    self.postMessage({
      type: 'PROGRESS',
      payload: { status: 'Sending to SAM service...', progress: 20 }
    });

    // Send to SAM service
    const formData = new FormData();
    formData.append('file', blob, 'image.png');
    formData.append('difficulty', difficulty);

    const response = await fetch('http://localhost:8001/segment', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || `SAM service error: ${response.status}`);
    }

    self.postMessage({
      type: 'PROGRESS',
      payload: { status: 'Processing segments...', progress: 70 }
    });

    const result = await response.json();
    console.log(`SAM returned ${result.count} segments`);

    self.postMessage({
      type: 'PROGRESS',
      payload: { status: 'Converting to SVG...', progress: 85 }
    });

    // Convert SAM response to SVG
    const svg = convertSAMToSVG(result);

    self.postMessage({
      type: 'PROGRESS',
      payload: { status: 'Complete!', progress: 100 }
    });

    self.postMessage({
      type: 'COMPLETE',
      payload: {
        svg,
        difficulty
      }
    });

  } catch (error) {
    self.postMessage({
      type: 'ERROR',
      payload: {
        message: error.message,
        stack: error.stack
      }
    });
  }
}

function convertSAMToSVG(samResult) {
  const { width, height, segments } = samResult;
  const outlineColor = '#0b0d0e';
  const outlineWidth = 2;

  let pathsMarkup = '';

  for (const segment of segments) {
    const { index, color, paths } = segment;

    // Convert each path to SVG path data
    for (const path of paths) {
      if (path.length < 3) continue;

      // Build path string
      let d = `M${path[0][0]} ${path[0][1]}`;
      for (let i = 1; i < path.length; i++) {
        d += ` L${path[i][0]} ${path[i][1]}`;
      }
      d += ' Z'; // Close path

      // Index is already 1-based from the service
      pathsMarkup += `<path d='${d}' data-index='${index}' data-color='${color}' fill='none'/>\n`;
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}' data-outline-color='${outlineColor}' data-outline-width='${outlineWidth}'>
  <rect x='0' y='0' width='${width}' height='${height}' fill='none'/>
  ${pathsMarkup}</svg>`;
}
