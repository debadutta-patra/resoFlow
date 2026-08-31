import React from 'react';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js';
import { useTheme } from '../context/ThemeContext';

// Handle Vite ESM/CommonJS interop for the factory
// @ts-ignore
const PlotlyComponent = (createPlotlyComponent.default || createPlotlyComponent)(Plotly);

interface PlotProps {
  data: any[];
  layout: any;
  config?: any;
  useResizeHandler?: boolean;
  style?: React.CSSProperties;
  className?: string;
  onHover?: (event: Readonly<Plotly.PlotMouseEvent>) => void;
  onUnhover?: (event: Readonly<Plotly.PlotMouseEvent>) => void;
  onClick?: (event: Readonly<Plotly.PlotMouseEvent>) => void;
  onSelected?: (event: Readonly<Plotly.PlotSelectionEvent>) => void;
  onRelayout?: (event: Readonly<Plotly.PlotRelayoutEvent>) => void;
}

/**
 * Standard colors used across the application for consistent visualization.
 */
export const PLOT_COLORS = {
  primary: '#6366f1',    // Indigo-500
  secondary: '#f43f5e',  // Rose-500
  success: '#10b981',    // Emerald-500
  warning: '#f59e0b',    // Amber-500
  error: '#ef4444',      // Red-500
  neutral: '#94a3b8',    // Slate-400
  background: 'rgba(0,0,0,0)',
  grid: '#f1f5f9',
  gridDark: '#f8fafc',
};

/**
 * Default layout properties for consistent look and feel.
 */
export const DEFAULT_LAYOUT = {
  autosize: true,
  paper_bgcolor: 'rgba(0,0,0,0)',
  plot_bgcolor: 'rgba(0,0,0,0)',
  margin: { l: 60, r: 20, b: 60, t: 20 },
  font: {
    family: 'Inter, sans-serif',
    size: 12,
  },
  xaxis: {
    gridcolor: PLOT_COLORS.grid,
    zeroline: false,
    tickfont: { size: 10, weight: 600 },
  },
  yaxis: {
    gridcolor: PLOT_COLORS.grid,
    zeroline: false,
    tickfont: { size: 10, weight: 600 },
  },
};

/**
 * Shared Plot component that wraps react-plotly.js with app-specific defaults.
 */
const Plot: React.FC<PlotProps> = ({ 
  data, 
  layout, 
  config = { responsive: true, displaylogo: false }, 
  useResizeHandler = true,
  style = { width: "100%", height: "100%" },
  className,
  ...props
}) => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  // Contrast-adjusted colors based on dark/light theme
  const textColor = isDark ? '#cdd6f4' : '#4c4f69';
  const gridColor = isDark ? 'rgba(205, 214, 244, 0.15)' : 'rgba(76, 79, 105, 0.15)';

  // Merge theme-aware properties with default layout
  const themeLayout = {
    ...DEFAULT_LAYOUT,
    font: {
      ...DEFAULT_LAYOUT.font,
      color: textColor,
    },
    xaxis: {
      ...DEFAULT_LAYOUT.xaxis,
      color: textColor,
      gridcolor: gridColor,
      title: {
        font: {
          color: textColor,
          size: 11,
          weight: 600,
        }
      },
      tickfont: {
        ...DEFAULT_LAYOUT.xaxis.tickfont,
        color: textColor,
      }
    },
    yaxis: {
      ...DEFAULT_LAYOUT.yaxis,
      color: textColor,
      gridcolor: gridColor,
      title: {
        font: {
          color: textColor,
          size: 11,
          weight: 600,
        }
      },
      tickfont: {
        ...DEFAULT_LAYOUT.yaxis.tickfont,
        color: textColor,
      }
    },
  };

  // Merge default theme layout with the layout prop passed from parents
  const mergedLayout = {
    ...themeLayout,
    ...layout,
    font: {
      ...themeLayout.font,
      ...layout?.font,
    },
    xaxis: {
      ...themeLayout.xaxis,
      ...layout?.xaxis,
      title: {
        ...themeLayout.xaxis.title,
        ...layout?.xaxis?.title,
        font: {
          ...themeLayout.xaxis.title?.font,
          ...layout?.xaxis?.title?.font,
        }
      },
      tickfont: {
        ...themeLayout.xaxis.tickfont,
        ...layout?.xaxis?.tickfont,
      }
    },
    yaxis: {
      ...themeLayout.yaxis,
      ...layout?.yaxis,
      title: {
        ...themeLayout.yaxis.title,
        ...layout?.yaxis?.title,
        font: {
          ...themeLayout.yaxis.title?.font,
          ...layout?.yaxis?.title?.font,
        }
      },
      tickfont: {
        ...themeLayout.yaxis.tickfont,
        ...layout?.yaxis?.tickfont,
      }
    },
    margin: {
      ...themeLayout.margin,
      ...layout?.margin,
    }
  };

  return (
    <PlotlyComponent
      data={data}
      layout={mergedLayout}
      config={config}
      useResizeHandler={useResizeHandler}
      style={style}
      className={className}
      {...props}
    />
  );
};

export { Plot };
export default Plot;


