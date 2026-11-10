import { useState } from 'react';
import classes from './Select.module.scss';
import Icon from '../../Icon/Icon';
import FormField from '../FormField/FormField';
import { onActivateKey } from '../../../../utils/keyboard';

type SelectOptionType = {
   id?: string;
   icon?: string;
   pro?: boolean;
   image?: JSX.Element;
   label: string;
   value: string;
   disabled?: boolean;
};

type SelectProps = {
   label?: string;
   size?: 'large' | 'medium' | 'small' | 'mini';
   full?: boolean;
   inline?: boolean;
   description?: string;
   customClasses?: string;
   disabled?: boolean;
   hint?: string;
   error?: string;
   search?: boolean;
   fieldValue: string;
   options: SelectOptionType[];
   onUpdate: (f: string) => void;
};

const Select = ({
   label = '',
   options = [],
   description,
   customClasses = '',
   fieldValue = '',
   size = 'medium',
   full = false,
   inline = false,
   disabled = false,
   hint = '',
   error = '',
   search = false,
   onUpdate,
}: SelectProps) => {
   const [showDropDown, setShowDropDown] = useState(false);
   const [searchText, setSearchText] = useState('');

   const selectedItemIndex = options.length > 0 && fieldValue ? options.findIndex((x) => x.value === fieldValue) : null;
   const selectedItem = selectedItemIndex === -1 ? options[0] : options[selectedItemIndex || 0];
   const selectedItemLabel = selectedItem && selectedItem.label ? selectedItem.label : (options[0] && options[0].label) || 'Select Item..';
   const selectedItemValue = selectedItem && selectedItem.value ? selectedItem.value : (options[0] && options[0].value) || '';
   const selectedItemImage = selectedItem && selectedItem.image ? selectedItem.image : '';
   const selectedItemIcon = selectedItem && selectedItem.icon ? selectedItem.icon : '';

   const updateOption = (val: string) => {
      onUpdate(val);
      setShowDropDown(false);
   };

   const optionsItems = searchText ? options.filter((s) => s.label.toLowerCase().includes(searchText.toLowerCase())) : options;

   return (
      <FormField
         type="select"
         label={label}
         description={description}
         hint={hint}
         error={error}
         required={false}
         inline={inline}
         classes={`${classes.selectField} ${classes[size]} ${full ? classes.selectFieldFull : ''} ${customClasses} ${error ? classes.fieldHasError : ''}`}
      >
         <div className={`${classes.dropdown} ${disabled ? classes.dropdownDisabled : ''}`}>
            <div className={classes.selected} onClick={() => setShowDropDown(!disabled ? !showDropDown : false)}>
               <span>
                  {selectedItemImage} {selectedItemIcon && <Icon type={selectedItemIcon} size={13} />} {selectedItemLabel}
               </span>
               <button
                  type="button"
                  className={classes.dropBtn}
                  aria-label={`${label || 'Options'}: ${selectedItemLabel}`}
                  aria-haspopup="listbox"
                  aria-expanded={showDropDown}
                  disabled={disabled}
               >
                  <Icon type={showDropDown ? 'caret-up' : 'caret-down'} size={12} />
               </button>
            </div>
            {showDropDown && (
               <div>
                  {search && (
                     <div className={classes.search}>
                        <Icon type="search" size={15} />
                        <input
                           placeholder="Search..."
                           aria-label="Search options"
                           value={searchText}
                           onChange={(e) => setSearchText(e.target.value)}
                        />
                        {searchText && (
                           <button type="button" aria-label="Clear search" onClick={() => setSearchText('')}>
                              <Icon type="close" size={15} />
                           </button>
                        )}
                     </div>
                  )}
                  <div className={`${classes.lists} styled__scrollbar`}>
                     <ul role="listbox" aria-label={label || 'Options'}>
                        {optionsItems.length > 0 &&
                           optionsItems.map((item, indx) => {
                              const selectable = !item.pro && !item.disabled;
                              return (
                                 <li
                                    key={indx}
                                    role="option"
                                    aria-selected={item.value === selectedItemValue}
                                    aria-disabled={!selectable || undefined}
                                    tabIndex={selectable ? 0 : -1}
                                    onClick={() => selectable && updateOption(item.value)}
                                    onKeyDown={onActivateKey(() => selectable && updateOption(item.value))}
                                    className={`${item.value === selectedItemValue ? classes.selectedItem : ''} ${item.disabled ? classes.disabledItem : ''}`}
                                 >
                                    {item.icon && <Icon type={item.icon} size={13} />}
                                    {item.image && item.image}
                                    {item.label}
                                 </li>
                              );
                           })}
                     </ul>
                     {searchText && !optionsItems && <div>No Providers Found</div>}
                  </div>
               </div>
            )}
         </div>
      </FormField>
   );
};

export default Select;
