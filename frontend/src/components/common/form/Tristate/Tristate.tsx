import Icon from '../../Icon/Icon';
import FormField from '../FormField/FormField';
import { onActivateKey } from '../../../../utils/keyboard';
import classes from './Tristate.module.scss';

type TristateProps = {
   label?: string;
   description?: string;
   customClasses?: string;
   inline?: boolean;
   hint?: string;
   fieldValue: string;
   options: { label: string; value: string; disabled?: boolean }[];
   onUpdate: (value: string) => void;
};

const Tristate = ({ label, description, customClasses = '', fieldValue = '', hint = '', inline = false, options, onUpdate }: TristateProps) => {
   const sortedOptions = [...options].sort((a, b) => {
      if (a.disabled === b.disabled) return 0;
      return a.disabled ? 1 : -1;
   });
   return (
      <FormField
         type="tristate"
         label={label}
         description={description}
         hint={hint}
         inline={inline}
         classes={`${classes.tristateField} ${customClasses}`}
      >
         <div className={classes.inputGroup}>
            <ul className={classes.optionSelector} role="radiogroup" aria-label={label}>
               {sortedOptions.map((option) => (
                  <li
                     key={option.value}
                     role="radio"
                     aria-checked={fieldValue === option.value}
                     aria-disabled={option.disabled || undefined}
                     tabIndex={option.disabled ? -1 : 0}
                     className={`${classes.option} ${fieldValue === option.value ? classes.selected : ''} ${option.disabled ? classes.optionDisabled : ''}`}
                     onClick={() => !option.disabled && onUpdate(option.value)}
                     onKeyDown={onActivateKey(() => !option.disabled && onUpdate(option.value))}
                  >
                     {fieldValue === option.value && <Icon type="check" size={12} />}
                     {option.label}
                  </li>
               ))}
            </ul>
         </div>
      </FormField>
   );
};

export default Tristate;
