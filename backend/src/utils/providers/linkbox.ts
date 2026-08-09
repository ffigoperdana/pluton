const linkboxSettings = [
	{
		label: 'Email',
		value: 'email',
		command: '--linkbox-email',
		fieldType: 'string',
		authFieldType: 'password',
		required: true,
		default: '',
		description: 'Your Linkbox account email address',
	},
	{
		label: 'Password',
		value: 'password',
		command: '--linkbox-password',
		fieldType: 'password',
		authFieldType: 'password',
		required: true,
		default: '',
		description: 'Your Linkbox account email password',
	},
	{
		label: 'Token',
		value: 'token',
		command: '--linkbox-token',
		fieldType: 'password',
		authFieldType: 'password',
		required: true,
		default: '',
		description: 'Token from https://www.linkbox.to/admin/account',
	},
	{
		label: 'Description',
		value: 'description',
		command: '--linkbox-description',
		fieldType: 'string',
		required: false,
		default: '',
		description: 'Description of the Storage.',
	},
];

export default linkboxSettings;
