import { useState } from 'react';
import Icon from './Icon';

interface StorageIconProps {
   type?: string;
   size?: number;
}

/** Shows the provider logo of a storage, and the generic storage icon for a local or unknown type. */
const StorageIcon = ({ type, size = 13 }: StorageIconProps) => {
   const [imageFailed, setImageFailed] = useState(false);

   if (!type || type === 'local' || imageFailed) {
      return <Icon type="storages" size={size} />;
   }
   return <img src={`/providers/${type}.png`} width={size} height={size} alt={type} onError={() => setImageFailed(true)} />;
};

export default StorageIcon;
