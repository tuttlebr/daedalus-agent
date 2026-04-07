import React, { useContext } from "react";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, AreaChart, Area,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ScatterChart, Scatter, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
  ComposedChart, Cell, ReferenceLine, Label as RechartsLabel, ZAxis
} from 'recharts';
import dynamic from 'next/dynamic';  // Import dynamic from Next.js
import HomeContext from "@/pages/api/home/home.context";
import * as htmlToImage from 'html-to-image'; // Import html-to-image for generating images
import { IconDownload } from "@tabler/icons-react";
import toast from "react-hot-toast";
import { Logger } from '@/utils/logger';

const logger = new Logger('Chart');

// Dynamically import the ForceGraph2D component with SSR disabled
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

// Utility function to generate a random color
const getRandomColor = () => {
  const letters = '0123456789ABCDEF';
  let color = '#';
  for (let i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return color;
};

const Chart = (props: any) => {
  const data = props?.payload;
  const {
    Label = '',
    ChartType = '',
    Data = [],
    XAxisKey = '',
    YAxisKey = '',
    ValueKey = '',
    NameKey = '',
    PolarAngleKey = '',
    PolarValueKey = '',
    BarKey = '',
    LineKey = '',
    Nodes = [],
    Links = [],
    XAxisLabel = '',
    YAxisLabel = '',
  } = data;

  const {
    state: { selectedConversation, conversations },
    dispatch,
  } = useContext(HomeContext);

  // NVIDIA brand colors for charts
  const colors = {
    fill: 'var(--color-nvidia-green)',
    stroke: 'black',
  };

  const handleDownload = async () => {
    try {
      const chartElement = document.getElementById(`chart-${Label}`);
      if (chartElement) {
        logger.info('Generating image to download...');
        const chartBackground = chartElement.style.background;
        // Set the chart background to white before capturing the image
        chartElement.style.background = 'white';
        // Capture the image
        const dataUrl = await htmlToImage.toPng(chartElement);
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = `${Label}-${ChartType}.png`;
        link.click();
        // Reset the chart background
        chartElement.style.background = chartBackground;
        logger.info('Image downloaded successfully.');
        toast.success('Downloaded successfully.');
      }
    } catch (error) {
      logger.error('Error generating download image:', error);
    }
  };


  const renderChart = () => {
    switch (ChartType) {
      case 'BarChart':
        return (
          <ResponsiveContainer width="100%" height={300} className={"p-2"}>
            <BarChart id={`chart-BarChart-${Label}`} data={Data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey={XAxisKey} />
              <YAxis />
              <Tooltip />
              <Legend />
              <Bar dataKey={YAxisKey} fill={colors.fill} />
            </BarChart>
          </ResponsiveContainer>
        );

      case 'LineChart':
        return (
          <ResponsiveContainer width="100%" height={300} className={"p-2"}>
            <LineChart id={`chart-LineChart-${Label}`} data={Data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey={XAxisKey} />
              <YAxis />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey={YAxisKey} stroke={colors.fill} />
            </LineChart>
          </ResponsiveContainer>
        );

      case 'PieChart':
        return (
          <ResponsiveContainer width="100%" height={300} className={"p-2"}>
            <PieChart id={`chart-PieChart-${Label}`}>
              <Tooltip />
              <Legend />
              <Pie
                data={Data}
                dataKey={ValueKey}
                nameKey={NameKey}
                fill={colors.fill}
                label
              >
                {Data.map((entry: any, index: number) => (
                  <Cell key={`cell-${index}`} fill={getRandomColor()} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        );

      case 'AreaChart':
        return (
          <ResponsiveContainer width="100%" height={300} className={"p-2"}>
            <AreaChart id={`chart-AreaChart-${Label}`} data={Data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey={XAxisKey} />
              <YAxis />
              <Tooltip />
              <Legend />
              <Area type="monotone" dataKey={YAxisKey} stroke={colors.stroke} fill={colors.fill} />
            </AreaChart>
          </ResponsiveContainer>
        );

      case 'RadarChart':
        return (
          <ResponsiveContainer width="100%" height={300} className={"p-2"}>
            <RadarChart id={`chart-RadarChart-${Label}`} data={Data}>
              <PolarGrid />
              <PolarAngleAxis dataKey={PolarAngleKey} />
              <PolarRadiusAxis />
              <Radar name="Metrics" dataKey={PolarValueKey} stroke={colors.stroke} fill={colors.fill} fillOpacity={0.6} />
              <Legend />
            </RadarChart>
          </ResponsiveContainer>
        );

      case 'ScatterChart':
        return (
          <ResponsiveContainer width="100%" height={300} className={"p-2"}>
            <ScatterChart id={`chart-ScatterChart-${Label}`}>
              <CartesianGrid />
              <XAxis type="number" dataKey={XAxisKey} name={XAxisKey} />
              <YAxis type="number" dataKey={YAxisKey} name={YAxisKey} />
              <Tooltip cursor={{ strokeDasharray: '3 3' }} />
              <Legend />
              <Scatter name="Sales vs Profit" data={Data} fill={colors.fill} />
            </ScatterChart>
          </ResponsiveContainer>
        );

      case 'ComposedChart':
        return (
          <ResponsiveContainer width="100%" height={300} className={"p-2"}>
            <ComposedChart id={`chart-ComposedChart-${Label}`} data={Data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey={XAxisKey} />
              <YAxis />
              <Tooltip />
              <Legend />
              <Bar dataKey={BarKey} fill={colors.fill} />
              <Line type="monotone" dataKey={LineKey} stroke={colors.stroke} />
            </ComposedChart>
          </ResponsiveContainer>
        );

      case 'QuadrantChart': {
        const xValues = Data.map((d: Record<string, number>) => d[XAxisKey]).filter((v: unknown): v is number => typeof v === 'number');
        const yValues = Data.map((d: Record<string, number>) => d[YAxisKey]).filter((v: unknown): v is number => typeof v === 'number');
        const sortedX = [...xValues].sort((a: number, b: number) => a - b);
        const sortedY = [...yValues].sort((a: number, b: number) => a - b);
        const xMedian = sortedX.length % 2 === 0
          ? (sortedX[sortedX.length / 2 - 1] + sortedX[sortedX.length / 2]) / 2
          : sortedX[Math.floor(sortedX.length / 2)];
        const yMedian = sortedY.length % 2 === 0
          ? (sortedY[sortedY.length / 2 - 1] + sortedY[sortedY.length / 2]) / 2
          : sortedY[Math.floor(sortedY.length / 2)];

        const quadrantColors = {
          topRight: '#76b900',
          topLeft: '#f59e0b',
          bottomRight: '#f59e0b',
          bottomLeft: '#ef4444',
        };

        const coloredData = Data.map((d: Record<string, number | string>) => {
          const x = d[XAxisKey] as number;
          const y = d[YAxisKey] as number;
          let fill = quadrantColors.bottomLeft;
          if (x >= xMedian && y >= yMedian) fill = quadrantColors.topRight;
          else if (x < xMedian && y >= yMedian) fill = quadrantColors.topLeft;
          else if (x >= xMedian && y < yMedian) fill = quadrantColors.bottomRight;
          return { ...d, _fill: fill };
        });

        const renderCustomLabel = (props: { cx?: number; cy?: number; index?: number }) => {
          const { cx = 0, cy = 0, index = 0 } = props;
          const item = Data[index];
          if (!item || !NameKey) return null;
          return (
            <text x={cx} y={cy - 10} textAnchor="middle" fontSize={11} fill="currentColor" opacity={0.85}>
              {item[NameKey]}
            </text>
          );
        };

        return (
          <ResponsiveContainer width="100%" height={420} className={"p-2"}>
            <ScatterChart id={`chart-QuadrantChart-${Label}`} margin={{ top: 20, right: 30, bottom: 30, left: 30 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis type="number" dataKey={XAxisKey} name={XAxisLabel || XAxisKey}>
                <RechartsLabel value={XAxisLabel || XAxisKey} position="bottom" offset={10} />
              </XAxis>
              <YAxis type="number" dataKey={YAxisKey} name={YAxisLabel || YAxisKey}>
                <RechartsLabel value={YAxisLabel || YAxisKey} angle={-90} position="insideLeft" offset={-15} style={{ textAnchor: 'middle' }} />
              </YAxis>
              <ZAxis range={[80, 80]} />
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                content={(({ active, payload }: { active?: boolean; payload?: Array<{ payload: Record<string, unknown> }> }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload;
                  return (
                    <div className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded p-2 shadow-lg text-sm">
                      <p className="font-semibold">{NameKey ? String(d[NameKey]) : ''}</p>
                      <p>{XAxisLabel || XAxisKey}: {String(d[XAxisKey])}</p>
                      <p>{YAxisLabel || YAxisKey}: {String(d[YAxisKey])}</p>
                    </div>
                  );
                }) as any}
              />
              <ReferenceLine x={xMedian} stroke="#666" strokeDasharray="5 5" />
              <ReferenceLine y={yMedian} stroke="#666" strokeDasharray="5 5" />
              <Scatter data={coloredData} label={renderCustomLabel as any}>
                {coloredData.map((entry: Record<string, string>, index: number) => (
                  <Cell key={`cell-${index}`} fill={entry._fill} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        );
      }

      case 'GraphPlot':
        return (
          <div style={{ width: "100%", height: "auto", display: "flex", justifyContent: "center", alignItems: "center", padding: "20px" }}>
            <ForceGraph2D
              graphData={{
                nodes: Nodes.map((node: any) => ({ id: node.id, name: node.label })),
                links: Links.map((link: any) => ({
                  source: link.source,
                  target: link.target,
                  label: link.label
                }))
              }}
              nodeLabel="name"
              linkLabel="label"
              nodeAutoColorBy="id"
              width={window.innerWidth * 0.9} // Adjust width to fit container
              height={500} // Set height to fit container
              // zoom={0.5} // Set zoom level (e.g., 2 for zoomed in)
            />
          </div>
        );

      default:
        return <div>No chart type found</div>;
    }
  };

  return (
    <div className="pb-2">
      <IconDownload className="w-4 h-4 hover:text-nvidia-green absolute top-[4.5rem] right-[4.5rem]" onClick={handleDownload} />
      <div className="pt-4" id={`chart-${Label}`}>
        <div className="pl-4">{Label}</div>
        {renderChart()}
      </div>
    </div>
  );
};

export default Chart;
