import PageHeader from '../../components/common/PageHeader/PageHeader';
import DeviceItem from '../../components/Device/DeviceItem/DeviceItem';
import TagsFilter from '../../components/common/TagsFilter/TagsFilter';
import SearchItems from '../../components/common/SearchItems/SearchItems';
import { useEffect, useMemo, useState } from 'react';
import { Device } from '../../@types/devices';
import { useGetDevices } from '../../services/devices';
import classes from './Sources.module.scss';
import ItemsLayout from '../../components/common/ItemsLayout/ItemsLayout';
import SkeletonItems from '../../components/Skeleton/SkeletonItems';
import deviceItemClasses from '../../components/Device/DeviceItem/DeviceItem.module.scss';
import AgentEnrollmentModal from '../../components/Device/AgentEnrollment/AgentEnrollment';

type SourcesProps = {
   buttonTitle?: string;
   buttonAction?: (bool: boolean) => void;
};

const Sources = ({ buttonTitle, buttonAction }: SourcesProps) => {
   const [devices, setDevices] = useState<Device[]>([]);
   const [devicesLayout, setDevicesLayout] = useState<'list' | 'grid'>(() => (localStorage.getItem('devices_layout') === 'grid' ? 'grid' : 'list'));
   const { data, isLoading } = useGetDevices({ refetchInterval: 15000 });
   const fetchedDevices: Device[] = data?.result || [];
   const [showEnrollment, setShowEnrollment] = useState(false);

   useEffect(() => {
      if (data?.result) {
         setDevices(data.result);
      }
   }, [data]);

   const allTags = useMemo(() => {
      const tags: string[] = [];
      if (devices && devices.length > 0) {
         devices.forEach(({ tags = [] }) => {
            console.log('tags :', tags);
            if (tags && Array.isArray(tags)) {
               tags.forEach((tag) => {
                  if (!tags.includes(tag)) {
                     tags.push(tag);
                  }
               });
            }
         });
      }

      return tags;
   }, [devices]);

   const filterByTags = (tag: string) => {
      if (tag) {
         setDevices(fetchedDevices.filter((p) => p.tags.includes(tag)));
      } else {
         setDevices(fetchedDevices);
      }
   };

   const searchStorages = (term: string) => {
      if (term) {
         setDevices(fetchedDevices.filter((p) => p.name.toLowerCase().includes(term.toLowerCase())));
      } else {
         setDevices(fetchedDevices);
      }
   };

   return (
      <div className={classes.devices}>
         <PageHeader
            title="Sources"
            icon="sources"
            buttonTitle={buttonTitle}
            buttonAction={buttonAction}
            rightSection={
               <>
                  <TagsFilter tags={allTags} onSelect={filterByTags} />
                  <SearchItems onSearch={(term) => searchStorages(term)} itemName="Sources" />
                  <ItemsLayout onChange={(value) => setDevicesLayout(value)} type="devices" value={devicesLayout} />
               </>
            }
         />
         <div className={`${classes.deviceItems} ${devicesLayout === 'grid' ? classes.devicesGrid : ''}`}>
            {!isLoading && devices.length > 0 && devices.map((device) => <DeviceItem key={device.id} device={device} layout={devicesLayout} />)}
            {!isLoading && (
               <div className={`${deviceItemClasses.device} ${classes.deviceUpgrade}`} onClick={() => setShowEnrollment(true)}>
                  + Add Remote Machine
               </div>
            )}
         </div>
         {isLoading && <SkeletonItems type="source" layout={devicesLayout} />}
         {showEnrollment && <AgentEnrollmentModal close={() => setShowEnrollment(false)} />}
      </div>
   );
};

export default Sources;
