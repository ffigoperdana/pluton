import { useState } from 'react';
import classes from './MultiSelect.module.scss';
import Icon from '../../Icon/Icon';
import FormField from '../FormField/FormField';
import { onActivateKey } from '../../../../utils/keyboard';

type MultiMultiSelectOptionType = {
   id?: string;
   icon?: string;
   pro?: boolean;
   image?: JSX.Element;
   label: string;
   value: string;
};

type MultiSelectProps = {
   label?: string;
   title?: string;
   size?: 'large' | 'medium' | 'small';
   full?: boolean;
   description?: string;
   customClasses?: string;
   disabled?: boolean;
   hint?: string;
   error?: string;
   search?: boolean;
   fieldValue: string[];
   options: MultiMultiSelectOptionType[];
   onUpdate: (f: string[]) => void;
};

const MultiSelect = ({
   label = '',
   title = '',
   options = [],
   description,
   customClasses = '',
   fieldValue = [],
   size = 'medium',
   full = false,
   disabled = false,
   hint = '',
   error = '',
   search = false,
   onUpdate,
}: MultiSelectProps) => {
   const [showDropDown, setShowDropDown] = useState(false);
   const [searchText, setSearchText] = useState('');

   const selectedItems = options.filter((item) => fieldValue.includes(item.value));

   const toggleOption = (val: string) => {
      let newValues;
      if (fieldValue.includes(val)) {
         newValues = fieldValue.filter((v) => v !== val);
      } else {
         newValues = [...fieldValue, val];
      }
      onUpdate(newValues);
   };

   const optionsItems = searchText ? options.filter((s) => s.label.toLowerCase().includes(searchText.toLowerCase())) : options;

   return (
      <FormField
         type="multiSelect"
         label={label}
         description={description}
         hint={hint}
         error={error}
         inline={false}
         classes={`${classes.multiSelectField} ${customClasses} ${size === 'large' ? classes.multiSelectFieldLarge : ''} ${showDropDown ? classes.multiSelectFieldOpen : ''} ${error ? classes.fieldHasError : ''} ${full ? classes.multiSelectFieldFull : ''} ${disabled ? classes.multiSelectFieldDisabled : ''}`}
      >
         <div className={classes.dropdown}>
            <div className={classes.selected} onClick={() => setShowDropDown(!disabled ? !showDropDown : false)}>
               <span>
                  {title ? (
                     <>
                        {title}
                        <i>
                           {fieldValue.length}/{options.length}
                        </i>
                     </>
                  ) : selectedItems.length > 0 ? (
                     `${selectedItems.length} items selected`
                  ) : (
                     'Select items...'
                  )}
               </span>
               <button
                  type="button"
                  className={classes.dropBtn}
                  aria-label={`${label || title || 'Options'}: ${fieldValue.length} of ${options.length} selected`}
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
                           placeholder="Search Providers..."
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
                     <ul role="listbox" aria-multiselectable="true" aria-label={label || title || 'Options'}>
                        {optionsItems.length > 0 &&
                           optionsItems.map((item, indx) => {
                              return (
                                 <li
                                    key={indx}
                                    role="option"
                                    aria-selected={fieldValue.includes(item.value)}
                                    aria-disabled={item.pro || undefined}
                                    tabIndex={item.pro ? -1 : 0}
                                    onClick={() => !item.pro && toggleOption(item.value)}
                                    onKeyDown={onActivateKey(() => !item.pro && toggleOption(item.value))}
                                    className={`${fieldValue.includes(item.value) ? classes.selectedItem : ''}`}
                                 >
                                    <Icon type={'check-circle-filled'} size={13} />
                                    {item.label}
                                 </li>
                              );
                           })}
                     </ul>
                     {searchText && !optionsItems.length && <div>No Providers Found</div>}
                  </div>
               </div>
            )}
         </div>
      </FormField>
   );
};

export default MultiSelect;
