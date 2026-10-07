// Import html-to-image for generating images
import { IconDownload } from '@tabler/icons-react';
import React from 'react';
import toast from 'react-hot-toast';

import dynamic from 'next/dynamic';

import { useFileSave } from '@/hooks/useFileSave';

import { Logger } from '@/utils/logger';

import * as htmlToImage from 'html-to-image';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  AreaChart,
  Area,
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ScatterChart,
  Scatter,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ComposedChart,
  Cell,
  ReferenceLine,
  Label as RechartsLabel,
  ZAxis,
} from 'recharts';

const logger = new Logger('Chart');

// Dynamically import the ForceGraph2D component with SSR disabled
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), {
  ssr: false,
});

const seriesColors = [
  'var(--text-secondary)',
  'var(--accent-neutral)',
  'var(--text-primary)',
  'var(--accent-primary)',
  'var(--accent-secondary)',
];

const Chart = (props: any) => {
  const { saveFile, fileSaveDialog } = useFileSave();
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

  // Chart emphasis follows the shared appearance palette.
  const colors = {
    fill: 'var(--color-nvidia-green)',
    stroke: 'var(--text-primary)',
  };

  const handleDownload = async () => {
    try {
      const chartElement = document.getElementById(`chart-${Label}`);
      if (chartElement) {
        logger.info('Generating image to download...');
        const blob = await htmlToImage.toBlob(chartElement, {
          backgroundColor: getComputedStyle(chartElement).backgroundColor,
        });
        if (!blob) throw new Error('Chart image is empty');
        if (saveFile(blob, `${Label}-${ChartType}.png`))
          toast.success('Download started.');
      }
    } catch (error) {
      logger.error('Error generating download image:', error);
    }
  };

  const renderChart = () => {
    switch (ChartType) {
      case 'BarChart':
        return (
          <ResponsiveContainer width="100%" height={300} className={'p-2'}>
            <BarChart id={`chart-BarChart-${Label}`} data={Data}>
              <CartesianGrid
                stroke="var(--border-subtle)"
                strokeDasharray="3 3"
              />
              <XAxis stroke="var(--text-secondary)" dataKey={XAxisKey} />
              <YAxis stroke="var(--text-secondary)" />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-surface-raised)',
                  color: 'var(--text-primary)',
                  borderColor: 'var(--border-subtle)',
                }}
                itemStyle={{ color: 'var(--text-primary)' }}
              />
              <Legend
                formatter={(value) => (
                  <span className="text-primary">{value}</span>
                )}
              />
              <Bar dataKey={YAxisKey} fill={colors.fill} />
            </BarChart>
          </ResponsiveContainer>
        );

      case 'LineChart':
        return (
          <ResponsiveContainer width="100%" height={300} className={'p-2'}>
            <LineChart id={`chart-LineChart-${Label}`} data={Data}>
              <CartesianGrid
                stroke="var(--border-subtle)"
                strokeDasharray="3 3"
              />
              <XAxis stroke="var(--text-secondary)" dataKey={XAxisKey} />
              <YAxis stroke="var(--text-secondary)" />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-surface-raised)',
                  color: 'var(--text-primary)',
                  borderColor: 'var(--border-subtle)',
                }}
                itemStyle={{ color: 'var(--text-primary)' }}
              />
              <Legend
                formatter={(value) => (
                  <span className="text-primary">{value}</span>
                )}
              />
              <Line type="monotone" dataKey={YAxisKey} stroke={colors.fill} />
            </LineChart>
          </ResponsiveContainer>
        );

      case 'PieChart':
        return (
          <ResponsiveContainer width="100%" height={300} className={'p-2'}>
            <PieChart id={`chart-PieChart-${Label}`}>
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-surface-raised)',
                  color: 'var(--text-primary)',
                  borderColor: 'var(--border-subtle)',
                }}
                itemStyle={{ color: 'var(--text-primary)' }}
              />
              <Legend
                formatter={(value) => (
                  <span className="text-primary">{value}</span>
                )}
              />
              <Pie
                data={Data}
                dataKey={ValueKey}
                nameKey={NameKey}
                fill={colors.fill}
                label
              >
                {Data.map((_: any, index: number) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={seriesColors[index % seriesColors.length]}
                  />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        );

      case 'AreaChart':
        return (
          <ResponsiveContainer width="100%" height={300} className={'p-2'}>
            <AreaChart id={`chart-AreaChart-${Label}`} data={Data}>
              <CartesianGrid
                stroke="var(--border-subtle)"
                strokeDasharray="3 3"
              />
              <XAxis stroke="var(--text-secondary)" dataKey={XAxisKey} />
              <YAxis stroke="var(--text-secondary)" />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-surface-raised)',
                  color: 'var(--text-primary)',
                  borderColor: 'var(--border-subtle)',
                }}
                itemStyle={{ color: 'var(--text-primary)' }}
              />
              <Legend
                formatter={(value) => (
                  <span className="text-primary">{value}</span>
                )}
              />
              <Area
                type="monotone"
                dataKey={YAxisKey}
                stroke={colors.stroke}
                fill={colors.fill}
              />
            </AreaChart>
          </ResponsiveContainer>
        );

      case 'RadarChart':
        return (
          <ResponsiveContainer width="100%" height={300} className={'p-2'}>
            <RadarChart id={`chart-RadarChart-${Label}`} data={Data}>
              <PolarGrid stroke="var(--border-subtle)" />
              <PolarAngleAxis
                stroke="var(--text-secondary)"
                dataKey={PolarAngleKey}
              />
              <PolarRadiusAxis stroke="var(--text-secondary)" />
              <Radar
                name="Metrics"
                dataKey={PolarValueKey}
                stroke={colors.stroke}
                fill={colors.fill}
                fillOpacity={0.6}
              />
              <Legend
                formatter={(value) => (
                  <span className="text-primary">{value}</span>
                )}
              />
            </RadarChart>
          </ResponsiveContainer>
        );

      case 'ScatterChart':
        return (
          <ResponsiveContainer width="100%" height={300} className={'p-2'}>
            <ScatterChart id={`chart-ScatterChart-${Label}`}>
              <CartesianGrid stroke="var(--border-subtle)" />
              <XAxis
                stroke="var(--text-secondary)"
                type="number"
                dataKey={XAxisKey}
                name={XAxisKey}
              />
              <YAxis
                stroke="var(--text-secondary)"
                type="number"
                dataKey={YAxisKey}
                name={YAxisKey}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-surface-raised)',
                  color: 'var(--text-primary)',
                  borderColor: 'var(--border-subtle)',
                }}
                itemStyle={{ color: 'var(--text-primary)' }}
                cursor={{ strokeDasharray: '3 3' }}
              />
              <Legend
                formatter={(value) => (
                  <span className="text-primary">{value}</span>
                )}
              />
              <Scatter name="Sales vs Profit" data={Data} fill={colors.fill} />
            </ScatterChart>
          </ResponsiveContainer>
        );

      case 'ComposedChart':
        return (
          <ResponsiveContainer width="100%" height={300} className={'p-2'}>
            <ComposedChart id={`chart-ComposedChart-${Label}`} data={Data}>
              <CartesianGrid
                stroke="var(--border-subtle)"
                strokeDasharray="3 3"
              />
              <XAxis stroke="var(--text-secondary)" dataKey={XAxisKey} />
              <YAxis stroke="var(--text-secondary)" />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-surface-raised)',
                  color: 'var(--text-primary)',
                  borderColor: 'var(--border-subtle)',
                }}
                itemStyle={{ color: 'var(--text-primary)' }}
              />
              <Legend
                formatter={(value) => (
                  <span className="text-primary">{value}</span>
                )}
              />
              <Bar dataKey={BarKey} fill={colors.fill} />
              <Line type="monotone" dataKey={LineKey} stroke={colors.stroke} />
            </ComposedChart>
          </ResponsiveContainer>
        );

      case 'QuadrantChart': {
        const xValues = Data.map(
          (d: Record<string, number>) => d[XAxisKey],
        ).filter((v: unknown): v is number => typeof v === 'number');
        const yValues = Data.map(
          (d: Record<string, number>) => d[YAxisKey],
        ).filter((v: unknown): v is number => typeof v === 'number');
        const sortedX = [...xValues].sort((a: number, b: number) => a - b);
        const sortedY = [...yValues].sort((a: number, b: number) => a - b);
        const xMedian =
          sortedX.length % 2 === 0
            ? (sortedX[sortedX.length / 2 - 1] + sortedX[sortedX.length / 2]) /
              2
            : sortedX[Math.floor(sortedX.length / 2)];
        const yMedian =
          sortedY.length % 2 === 0
            ? (sortedY[sortedY.length / 2 - 1] + sortedY[sortedY.length / 2]) /
              2
            : sortedY[Math.floor(sortedY.length / 2)];

        const quadrantColors = {
          topRight: 'var(--color-success)',
          topLeft: 'var(--color-warning)',
          bottomRight: 'var(--color-warning)',
          bottomLeft: 'var(--color-error)',
        };

        const coloredData = Data.map((d: Record<string, number | string>) => {
          const x = d[XAxisKey] as number;
          const y = d[YAxisKey] as number;
          let fill = quadrantColors.bottomLeft;
          if (x >= xMedian && y >= yMedian) fill = quadrantColors.topRight;
          else if (x < xMedian && y >= yMedian) fill = quadrantColors.topLeft;
          else if (x >= xMedian && y < yMedian)
            fill = quadrantColors.bottomRight;
          return { ...d, _fill: fill };
        });

        const renderCustomLabel = (props: {
          cx?: number;
          cy?: number;
          index?: number;
        }) => {
          const { cx = 0, cy = 0, index = 0 } = props;
          const item = Data[index];
          if (!item || !NameKey) return null;
          return (
            <text
              x={cx}
              y={cy - 10}
              textAnchor="middle"
              fontSize={11}
              fill="currentColor"
              opacity={0.85}
            >
              {item[NameKey]}
            </text>
          );
        };

        return (
          <ResponsiveContainer width="100%" height={420} className={'p-2'}>
            <ScatterChart
              id={`chart-QuadrantChart-${Label}`}
              margin={{ top: 20, right: 30, bottom: 30, left: 30 }}
            >
              <CartesianGrid
                stroke="var(--border-subtle)"
                strokeDasharray="3 3"
              />
              <XAxis
                type="number"
                dataKey={XAxisKey}
                name={XAxisLabel || XAxisKey}
              >
                <RechartsLabel
                  value={XAxisLabel || XAxisKey}
                  position="bottom"
                  offset={10}
                />
              </XAxis>
              <YAxis
                type="number"
                dataKey={YAxisKey}
                name={YAxisLabel || YAxisKey}
              >
                <RechartsLabel
                  value={YAxisLabel || YAxisKey}
                  angle={-90}
                  position="insideLeft"
                  offset={-15}
                  style={{ textAnchor: 'middle' }}
                />
              </YAxis>
              <ZAxis range={[80, 80]} />
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                content={
                  (({
                    active,
                    payload,
                  }: {
                    active?: boolean;
                    payload?: Array<{ payload: Record<string, unknown> }>;
                  }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload;
                    return (
                      <div className="bg-panel border border-separator rounded p-2 shadow-lg text-sm">
                        <p className="font-semibold">
                          {NameKey ? String(d[NameKey]) : ''}
                        </p>
                        <p>
                          {XAxisLabel || XAxisKey}: {String(d[XAxisKey])}
                        </p>
                        <p>
                          {YAxisLabel || YAxisKey}: {String(d[YAxisKey])}
                        </p>
                      </div>
                    );
                  }) as any
                }
              />
              <ReferenceLine
                x={xMedian}
                stroke="var(--text-secondary)"
                strokeDasharray="5 5"
              />
              <ReferenceLine
                y={yMedian}
                stroke="var(--text-secondary)"
                strokeDasharray="5 5"
              />
              <Scatter data={coloredData} label={renderCustomLabel as any}>
                {coloredData.map(
                  (entry: Record<string, string>, index: number) => (
                    <Cell key={`cell-${index}`} fill={entry._fill} />
                  ),
                )}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        );
      }

      case 'GraphPlot':
        return (
          <div
            style={{
              width: '100%',
              height: 'auto',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              padding: '20px',
            }}
          >
            <ForceGraph2D
              graphData={{
                nodes: Nodes.map((node: any) => ({
                  id: node.id,
                  name: node.label,
                })),
                links: Links.map((link: any) => ({
                  source: link.source,
                  target: link.target,
                  label: link.label,
                })),
              }}
              nodeLabel="name"
              linkLabel="label"
              nodeColor={() =>
                getComputedStyle(document.documentElement)
                  .getPropertyValue('--text-secondary')
                  .trim()
              }
              linkColor={() =>
                getComputedStyle(document.documentElement)
                  .getPropertyValue('--text-secondary')
                  .trim()
              }
              width={window.innerWidth * 0.9}
              height={500}
            />
          </div>
        );

      default:
        return <div>No chart type found</div>;
    }
  };

  return (
    <div className="chart-surface relative pb-2 bg-panel text-primary">
      {fileSaveDialog}
      <button
        type="button"
        aria-label="Download chart"
        onClick={handleDownload}
        className="ml-auto flex min-h-11 min-w-11 items-center justify-center rounded-lg text-primary hover:text-nvidia-green"
      >
        <IconDownload size={20} />
      </button>
      <div className="pt-4 bg-panel" id={`chart-${Label}`}>
        <div className="pl-4">{Label}</div>
        {renderChart()}
      </div>
    </div>
  );
};

export default Chart;
