import Icon from '../../Icon/Icon';
import FormField from '../FormField/FormField';
import { onActivateKey } from '../../../../utils/keyboard';
import classes from './RadioIconSelect.module.scss';

interface RadioIconSelectProps {
   label: string;
   options: { label: string; description: string; value: string; icon: string; disabled?: boolean }[];
   fieldValue: string;
   layout?: 'grid' | 'list';
   disabled?: boolean;
   showDescription?: boolean;
   hint?: string;
   inline?: boolean;
   onUpdate: (type: string) => void;
   onDisableClick?: (value: string) => void;
}

const RadioIconSelect = ({
   label,
   options,
   fieldValue,
   showDescription = false,
   disabled = false,
   hint,
   inline = false,
   layout = 'grid',
   onUpdate,
   onDisableClick,
}: RadioIconSelectProps) => {
   const groupLabel = label,
      groupDisabled = disabled;
   return (
      <FormField type="radioIconSelect" label={label} classes={classes.radioIconField} hint={hint} inline={inline}>
         <div
            role="radiogroup"
            aria-label={groupLabel}
            aria-disabled={groupDisabled || undefined}
            className={`${classes.radioIconFieldOptions} ${disabled ? classes.radioIconFieldOptionsDisabled : ''} ${showDescription ? classes.radioIconFieldOptionsDesc : ''} ${layout === 'list' ? classes.radioIconFieldList : ''}`}
         >
            {options.map((option) => {
               const { label, value, icon, description, disabled = false } = option;
               // Contract: a disabled group is read-only (no onUpdate, no option prompts).
               // A disabled option is never selected; it may only explain itself via onDisableClick.
               const interactive = !groupDisabled && (!disabled || !!onDisableClick);
               // Mouse and keyboard share this handler.
               const choose = () => {
                  if (groupDisabled) return;
                  if (disabled) {
                     onDisableClick?.(value);
                     return;
                  }
                  onUpdate(value);
               };
               return (
                  <div
                     key={value}
                     role="radio"
                     aria-checked={fieldValue === value}
                     aria-disabled={disabled || groupDisabled || undefined}
                     tabIndex={interactive ? 0 : -1}
                     className={`${classes.radioIconFieldOption} ${disabled ? classes.radioIconFieldDisabled : ''} ${fieldValue === value ? classes.radioIconFieldActive : ''}`}
                     onClick={choose}
                     onKeyDown={onActivateKey(choose)}
                     data-tooltip-id="appTooltip"
                     data-tooltip-content={description}
                     data-tooltip-place="top"
                     data-tooltip-delay-show={300}
                  >
                     {fieldValue === value && <Icon classes="checkMark" type="check-circle-filled" size={14} />}
                     <div className={classes.radioIconFieldIcon}>
                        <Icon type={icon} size={30} />
                     </div>
                     <div className={classes.radioIconFieldContent}>
                        {showDescription ? (
                           <>
                              <h4>{label}</h4>
                              <p>{description}</p>
                           </>
                        ) : (
                           <h4>{label}</h4>
                        )}
                     </div>
                  </div>
               );
            })}
         </div>
      </FormField>
   );
};

export default RadioIconSelect;
