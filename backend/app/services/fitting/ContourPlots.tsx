import React from 'react';
import Plot from 'react-plotly.js';

// Assuming a type definition like this exists for your API response
interface SingleClusterFitResponse {
  x_ppm: number[];
  y_ppm: number[];
  experimental: (number | null)[][];
  model: (number | null)[][];
  residuals: (number | null)[][];
  // ... other properties
}

interface ContourPlotsProps {
  plotData: SingleClusterFitResponse | null;
}

const ContourPlots: React.FC<ContourPlotsProps> = ({ plotData }) => {
  if (!plotData || !plotData.experimental || plotData.experimental.length === 0) {
    return (
        <div className="flex items-center justify-center h-64 bg-gray-100 rounded-lg my-4">
            <p className="text-gray-500">No plot data available. Run a fit to see results.</p>
        </div>
    );
  }

  const { x_ppm, y_ppm, experimental, model, residuals } = plotData;

  const flatExpValues = experimental.flat().filter(v => v !== null) as number[];
  const expMin = Math.min(...flatExpValues);
  const expMax = Math.max(...flatExpValues);

  // Common layout properties for all plots
  const commonAxisProps = {
    autorange: 'reversed' as const,
    zeroline: false,
    showgrid: false,
  };

  const commonLayout = {
    width: 350,
    height: 350,
    margin: { l: 50, r: 20, b: 50, t: 50 },
    xaxis: { ...commonAxisProps, title: 'F2 (ppm)' },
    yaxis: { ...commonAxisProps, title: 'F1 (ppm)' },
    font: {
        family: 'sans-serif',
        size: 12,
    },
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4 bg-white rounded-lg shadow-md my-4">
      {/* Experimental Data Plot */}
      <div className="flex flex-col items-center">
        <h3 className="font-semibold text-lg mb-2">Experimental</h3>
        <Plot
          data={[
            {
              x: x_ppm,
              y: y_ppm,
              z: experimental,
              type: 'contour',
              colorscale: 'Viridis',
              contours: { coloring: 'heatmap' },
              showscale: false,
            },
          ]}
          layout={{ ...commonLayout }}
          config={{ responsive: true }}
        />
      </div>

      {/* Model Data Plot */}
      <div className="flex flex-col items-center">
        <h3 className="font-semibold text-lg mb-2">Model</h3>
        <Plot
          data={[
            {
              x: x_ppm,
              y: y_ppm,
              z: model,
              type: 'contour',
              colorscale: 'Viridis',
              zmin: expMin,
              zmax: expMax,
              contours: { coloring: 'heatmap' },
              showscale: false,
            },
          ]}
          layout={{ ...commonLayout }}
          config={{ responsive: true }}
        />
      </div>

      {/* Residuals Plot */}
      <div className="flex flex-col items-center">
        <h3 className="font-semibold text-lg mb-2">Residuals</h3>
        <Plot
          data={[
            {
              x: x_ppm,
              y: y_ppm,
              z: residuals,
              type: 'contour',
              colorscale: 'RdBu',
              reversescale: true,
              contours: { coloring: 'heatmap' },
              showscale: true,
              colorbar: {
                  title: 'Intensity',
                  titleside: 'right',
              }
            },
          ]}
          layout={{ ...commonLayout }}
          config={{ responsive: true }}
        />
      </div>
    </div>
  );
};

export default ContourPlots;