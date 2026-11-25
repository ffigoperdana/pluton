import { BRAND_MARK_PATHS, BRAND_MARK_VIEWBOX } from '../../../utils/brand';

interface LogoProps {
   size: number;
   color?: string;
   faceColor?: string;
   emotion?: string;
}

const Logo = ({ size = 60, color = '' }: LogoProps) => {
   return (
      <svg height={size} viewBox={BRAND_MARK_VIEWBOX} width={size} xmlns="http://www.w3.org/2000/svg">
         <g fill={color || 'currentColor'}>
            {BRAND_MARK_PATHS.map((d) => (
               <path key={d} d={d} />
            ))}
         </g>
      </svg>
   );
};

export default Logo;
