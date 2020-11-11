/** 
 * Avaya voice and sms channel
 * version 0.1
 */
interface CPaaSRequest {
	body: CPaaSBody;
}

interface CPaaSBody {
	AccountSid: string;
	AnsweredBy: string;
	ApiVersion: string;
	CallDuration: string;
	CallSid: string;
	CallerName: string;
	Direction: string;
	From: string;
	SipCallId: string;
	StatusCallback: string;
	To: string;
	UrlBase: string;
	Digits: string;
	SpeechResult: string;
	Body: string;
	SmsSid: string;
}

const COGNIGY_BASE_URL = 'https://endpoint-trial.cognigy.ai/';
const DEBUG_MODE = false;

createRestTransformer({

	/**
	 * This transformer is executed when receiving a message
	 * from the user, before executing the Flow.
	 *
	 * @param endpoint The configuration object for the used Endpoint.
	 * @param request The Express request object with a JSON parsed body.
	 * @param response The Express response object.
	 *
	 * @returns A valid userId, sessionId, as well as text and/or data,
	 * which has been extracted from the request body.
	 */
	handleInput: async ({ endpoint, request, response }) => {

		/**
		 * Extract the userId, sessionId and text
		 * from the request. Example:
		 *
		 * const { userId, sessionId, text, data } = request.body;
		 *
		 * Note that the format of the request body will be different for
		 * every Endpoint, and the example above needs to be adjusted
		 * accordingly.
		 */
		const { body } = request as CPaaSRequest;
		if (DEBUG_MODE) {
			console.log('body='.concat(JSON.stringify(body)));
		}
		const { From, To, CallSid, Digits, SpeechResult, SmsSid, Body } = body;
		const userId = From;
		const sessionId = CallSid ? CallSid : SmsSid;
		let sessionStorage = await getSessionStorage(userId, sessionId);
		sessionStorage.From = From;
		sessionStorage.To = To;
		sessionStorage.cpaas_channel = CallSid ? 'call' : 'sms';
		let data = { "call": false, "sms": false, "phone": From };
		const menu = sessionStorage['menu'] ? sessionStorage['menu'] : {};
		let text = '';
		switch (sessionStorage.cpaas_channel) {
			case 'call':
				text = Digits ? (menu[Digits] ? menu[Digits] : 'default') : SpeechResult;
				data.call = true;
				break;
			case 'sms':
				text = Body;
				data.sms = true;
				break;
			default:
				text = 'default';
				break;
		}
		if (DEBUG_MODE) {
			console.log('input.text='.concat(text));
		}
		return {
			userId,
			sessionId,
			text,
			data
		};
	},

	/**
	 * This transformer is executed on every output from the Flow.
	 * 
	 * @param output The raw output from the Flow. It is possible to manipulate
	 * and return every distinct output before they get formatted in the 'handleExecutionFinished'
	 * transformer.
	 *
	 * @param endpoint The configuration object for the used Endpoint.
	 * @param userId The unique ID of the user.
	 * @param sessionId The unique ID for this session. Can be used together with the userId
	 * to retrieve the sessionStorage object.
	 * 
	 * @returns The output that will be formatted into the final response in the 'handleExecutionFinished' transformer.
	 */
	handleOutput: async ({ output, endpoint, userId, sessionId }) => {
		const sessionStorage = await getSessionStorage(userId, sessionId);
		if (output.data != null && output.data._cognigy != null) {
			const payload = output.data._cognigy;
			if (DEBUG_MODE) {
				console.log('payload='.concat(JSON.stringify(payload)));
			}
			const activities = payload._spoken.json.activities;
			activities.forEach((activity) => {
				switch (activity.name) {
					case 'handover':
						const dest = activity.activityParams.destination;
						const cbUrl = (activity.activityParams.callbackUrl != null) ?
							(' callbackUrl="' + activity.activityParams.callbackUrl + '"') : '';
						let dial = '<Dial' + cbUrl + '>' + dest + '</Dial>';
						output.text = (output.text != null) ? (output.text + dial) : dial;
						sessionStorage.dial = true;
						break;
					case 'prompt':
						const menu = activity.activityParams.menu;
						sessionStorage['menu'] = menu;
						output.text = (sessionStorage.cpaas_channel == 'sms') ? activity.activityParams.text : ('<Say>' + activity.activityParams.text + '</Say>');
						sessionStorage.dtmf = true;
						break;
					case 'hangup':
						sessionStorage.hangup = true;
						break;
					case 'play':
						if (sessionStorage.cpaas_channel == 'call') {
							output.text += '<Play>' + (activity.activityParams.url ? activity.activityParams.url : "") + '</Play>';
						} else {
							output.text = activity.activityParams.text;
						}
						break;
					case 'record':
						if (activity.activityParams.shouldRecord) {
							sessionStorage.record = '<Record method="POST" finishOnKey="#" action="' + activity.activityParams.actionUrl + '"/>';
						} else {
							sessionStorage.record = null;
						}
						break;
					case 'conference':
						sessionStorage.conference = true;
						let conferenceRoom = activity.activityParams.conferenceRoom ? activity.activityParams.conferenceRoom : "";
						let confRoom = conferenceRoom.replace('+', '');
						let conf = '<Dial><Conference startConferenceOnEnter="true" maxParticipants="2">' + confRoom + '</Conference></Dial>';
						output.text = (output.text != null) ? (output.text + conf) : conf;
						break;
					default:
						break;
				}
			});
		} else if (output.text != null && (sessionStorage.cpaas_channel == 'call')) {
			output.text = '<Say>' + output.text + '</Say>';
		}
		return output;
	},

	/**
	 * This transformer is executed when the Flow execution has finished.
	 * For REST based transformers, the final output will be sent to
	 * the user.
	 *
	 * @param processedOutput This is the final object that will be sent to the user.
	 * It is therefore structured according to the Endpoint channel of the transformer.
	 *
	 * @param outputs This is an array of all of the outputs that were output by the Flow.
	 * These will be merged to create the 'processedOutput' object.
	 * 
	 * @param userId The unique ID of the user.
	 * @param sessionId The unique ID for this session. Can be used together with the userId
	 * to retrieve the sessionStorage object.
	 * @param endpoint The configuration object for the used Endpoint.
	 * @param response The express response object that can be used to send a custom response back to the user.
	 *
	 * @returns An object that will be sent to the user, unchanged. It therefore has to have the
	 * correct format according to the documentation of the specific Endpoint channel.
	 */
	handleExecutionFinished: async ({ processedOutput, outputs, userId, sessionId, endpoint, response }) => {
		let url = COGNIGY_BASE_URL + endpoint.URLToken;
		const sessionStorage = await getSessionStorage(userId, sessionId);
		let cpaasResponse = 'default';
		switch (sessionStorage.cpaas_channel) {
			case 'call':
				cpaasResponse = getCPaaSCallCmd(sessionStorage, url, outputs);
				break;
			case 'sms':
				cpaasResponse = getCPaaSSmsCmd(sessionStorage, url, outputs);
				break;
			default:
				break;
		}
		response.send(cpaasResponse);
		if (DEBUG_MODE) {
			console.log('CPaaS cmd='.concat(cpaasResponse));
		}
		return processedOutput;
	}
});

const getCPaaSCallCmd = (sessionStorage, url, outputs) => {
	let dial = sessionStorage.dial;
	let hangup = sessionStorage.hangup;
	let dtmf = sessionStorage.dtmf;
	let record = sessionStorage.record ? sessionStorage.record : '';
	let conference = sessionStorage.conference;
	let ctrlcmd = dial | hangup | conference;
	sessionStorage.dial = false;
	sessionStorage.hangup = false;
	sessionStorage.dtmf = false;
	sessionStorage.record = null;
	sessionStorage.conference = false;
	let prompt = outputs.map((t) => { return t.text }).join('\n');
	let numDigits = dtmf ? 'numDigits="1"' : '';
	let gather = '<Gather method="POST" action="' + url + '" input="speech dtmf" language="en-US" timeout="3" ' + numDigits + '>' + prompt + '</Gather>';
	let cpaasResponse = '<Response>' + (record) + (ctrlcmd ? prompt : gather) + '</Response>';
	return (cpaasResponse);
};

const getCPaaSSmsCmd = (sessionStorage, url, outputs) => {
	let text = outputs.map((t) => { return t.text }).join('\n');
	let From = sessionStorage.To;
	let To = sessionStorage.From;
	let FromTo = ' From="' + From + '" To="' + To + '"';
	let cpaasResponse = '<Response><Sms action="' + url + FromTo + '>' + text + '</Sms></Response>';
	return (cpaasResponse);
}