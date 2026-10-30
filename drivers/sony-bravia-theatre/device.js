const Homey = require('homey');
const SonyTheatreTcp = require('../../lib/sony-theatre-tcp');

class SonyBraviaTheatreDevice extends Homey.Device {
  onDiscoveryResult(discoveryResult) {
    // Return a truthy value here if the discovery result matches your device.
    return discoveryResult.id === this.getData().id;
  }

  async onDiscoveryAvailable(discoveryResult) {
    // This method will be executed once when the device has been found (onDiscoveryResult returned true)
    this.setStoreValue('address', discoveryResult.address);
    this._clearIntervals();
    await this._getApi();
    this._checkDeviceInterval();
  }

  async onDiscoveryAddressChanged(discoveryResult) {
    // Update your connection details here, reconnect when the device is offline
    this.setStoreValue('address', discoveryResult.address);
    this._clearIntervals();
    await this._getApi();
    this._checkDeviceInterval();
  }

  async onDiscoveryLastSeenChanged(discoveryResult) {
    // When the device is offline, try to reconnect here
    this.setStoreValue('address', discoveryResult.address);
    this._clearIntervals();
    await this._getApi();
    this._checkDeviceInterval();
  }

  async onInit() {
    this.log(`${this.getData().name} initialized.`);
    await this._updateCapabilities();

    this._setCapabilityListeners();
    // this._setFlowTrigger();

    await this._getApi();
    
    this._checkDeviceInterval();
  }

  async _updateCapabilities(){
		let capabilities = [];
		try{
		capabilities = this.homey.app.manifest.drivers.filter((e) => {return (e.id == this.driver.id);})[0].capabilities;
		// remove capabilities
		let deviceCapabilities = this.getCapabilities();
		for (let i=0; i<deviceCapabilities.length; i++){
			let filter = capabilities.filter((e) => {return (e == deviceCapabilities[i]);});
			if (filter.length == 0 ){
			try{
				await this.removeCapability(deviceCapabilities[i]);
			}
			catch(error){}
			}
		}
		// add missing capabilities
		for (let i=0; i<capabilities.length; i++){
			if (!this.hasCapability(capabilities[i])){
			try{
				await this.addCapability(capabilities[i]);
			}
			catch(error){}
			}
		}
		}
		catch (error){
		this.error(error.message);
		}
  }

  onUninit(){
    this._clearIntervals();
    this.api?.close();
    this.log(`${this.getName()} unInit().`);
  }

  onDeleted() {
    this._clearIntervals();
    this.api?.close();
    this.log(`${this.getName()} deleting.`);
  }

    /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log(`[Device] ${this.getName()}: ${this.getData().id} settings where changed: ${changedKeys}`);
    this._clearIntervals();
    this._checkDeviceInterval({
      interval: newSettings.polling, 
      unit: newSettings.polling_unit
    });
  }

  async _getApi() {
    try{
      if (this.api) {
        this.api?.close();
      }
      this.api = new SonyTheatreTcp({
        host: this.getStoreValue('address'),
        port: this.getStoreValue('tcpPort'),
      });
      this.api.on('notification', ({ feature, value }) => this._onNotification({ feature, value }));
      // this.api.on('rawData', data => {
      //   this.log('Sony TCP received:', JSON.stringify(data));
      // });    
      this.api.on('disconnect', () => {
        this.log('Sony TCP disconnected');
      });
      this.api.on('connectionError', error => {
        this.log('Sony TCP error:', error);
      });
      await this.api.connect();
      this.log('Sony TCP connected:', this.api.connected);

      return this.api;
    } catch (error) {
      this.log("_getApi() error:", error.message);
    }
  }

  async _setCapabilityListeners() {
    // Register all capability listener
		this.registerCapabilityListener('onoff', this._onCapabilityOnoff.bind(this));
		this.registerCapabilityListener('volume_up', this._onCapabilityVolumeUp.bind(this));
		this.registerCapabilityListener('volume_down', this._onCapabilityVolumeDown.bind(this));
		this.registerCapabilityListener('volume_mute', this._onCapabilityVolumeMute.bind(this));
		this.registerCapabilityListener('volume_set', this._onCapabilityVolumeSet.bind(this));
		this.registerCapabilityListener('voice_enhancer', this._onCapabilityVoiceEnhancer.bind(this));
		this.registerCapabilityListener('sound_field', this._onCapabilitySoundField.bind(this));
		this.registerCapabilityListener('night_mode', this._onCapabilityNightMode.bind(this));
		this.registerCapabilityListener('drc', this._onCapabilityDrc.bind(this));
		this.registerCapabilityListener('rear_level', this._onCapabilityRearLevel.bind(this));
		this.registerCapabilityListener('bass_level', this._onCapabilityBassLevel.bind(this));
		this.registerCapabilityListener('input_theatre', this._onCapabilityInputTheatre.bind(this));

  }

  async _setFlowTrigger(){
  }

  _checkDeviceInterval({
      interval = this.getSetting('polling'), 
      unit = this.getSetting('polling_unit')} = {}) {

    // Interval settings is in minutes, convert to milliseconds.
    interval = interval * 1000;
    if (unit == 'min'){
      interval = interval * 60;
    }
    try {
      this.log(`[Device] ${this.getName()}: onPollInterval =>`, interval);
      this.onPollInterval =  this.homey.setInterval(() => this.checkDevice(), interval);
      // Update device after command action
      this.checkDevice();
    } catch (error) {
      this.log(error);
    }
  }

  async _clearIntervals() {
    try {
      this.log(`[Device] ${this.getName()}: clearIntervals`);
      this.homey.clearInterval(this.onPollInterval);
    } catch (error) {
      this.log(error);
    }
  }

  async checkDevice() {
    // this.log("Check device state...");
    if (await this._checkDeviceAvailability()){
      await this._checkDevicePowerState();
      await this._checkDeviceVolume();
      await this._checkDeviceStates();
      await this._checkDeviceInput();
    }
  }

  async _checkDeviceAvailability() {
    // Don't set device unavailable. Keep it available but off to turn ov with wWoL
    try {
      await this.api.getPower();
      // this.log("Check device availability: TRUE");
      return true;
      // return this.setAvailable();
    } catch (err) {
      // this.log("Check device availability: FALSE");
      // return this.setUnavailable();
      return false;
    }
  }

  async _checkDevicePowerState() {
    try {
      let state = await this.api.getPower();
      await this.setCapabilityValue('onoff', state === 'on' ? true : false);
    } 
    catch (err) {
      await this.setCapabilityValue('onoff', false);
    }
  }

  async _checkDeviceVolume() {
    try {
      let volume = await this.api.getVolume();
      await this.setCapabilityValue('volume_set', volume / 100);
      let mute = await this.api.getMute();
      await this.setCapabilityValue('volume_mute', mute === 'on' ? true : false);
      let rear_level = await this.api.getRearLevel();
      await this.setCapabilityValue('rear_level', rear_level);
      let bass_level = await this.api.getBassLevel();
      await this.setCapabilityValue('bass_level', bass_level);
    } 
    catch (err) {
    }
  }

  async _checkDeviceStates() {
    try {
      let voiceEnhancer = await this.api.getVoiceEnhancer();
      await this.setCapabilityValue('voice_enhancer', voiceEnhancer === 'on' ? true : false);
      let soundField = await this.api.getSoundField();
      await this.setCapabilityValue('sound_field', soundField === 'on' ? true : false);
      let nightMode = await this.api.getNightMode();
      await this.setCapabilityValue('night_mode', nightMode === 'on' ? true : false);
      let drc = await this.api.getDrc();
      await this.setCapabilityValue('drc', drc === 'on' ? true : false);
    } 
    catch (err) {
    }
  }
  async _checkDeviceInput() {
    try {
      let input = await this.api.getSource();
      await this.setCapabilityValue('input_theatre', input);
    } 
    catch (err) {
    }
  }

  async _onNotification({ feature, value }) {
    this.log(`[Device] ${this.getName()}: onNotification =>`, feature, value);
    switch (feature) {
      case 'main.power':
        await this.setCapabilityValue('onoff', value === 'on' ? true : false);
        break;
      case 'main.volumestep':
        await this.setCapabilityValue('volume_set', value / 100);
        break;
      case 'main_mute':
        await this.setCapabilityValue('volume_mute', value === 'on' ? true : false);
        break;
      case 'main.voice_enhancer':
        await this.setCapabilityValue('voice_enhancer', value === 'on' ? true : false);
        break;
      case 'main.sound_field':
        await this.setCapabilityValue('sound_field', value === 'on' ? true : false);
        break;
      case 'main.night_mode':
        await this.setCapabilityValue('night_mode', value === 'on' ? true : false);
        break;
      case 'main.drc':
        await this.setCapabilityValue('drc', value === 'on' ? true : false);
        break;
      case 'main.rear_level':
        await this.setCapabilityValue('rear_level', value);
        break;
      case 'main.bass_level':
        await this.setCapabilityValue('bass_level', value);
        break;
      case 'main.input_theatre':
        await this.setCapabilityValue('input_theatre', value);
        break;
      default:
        this.log(`[Device] ${this.getName()}: Unknown notification feature =>`, feature, value);
    }
  }

  async _onCapabilityOnoff(value, opts){
    this.log(`[Device] ${this.getName()}: onCapabilityOnoff =>`, value);
    let response = await this.api.setPower(value);
    if (response !== 'ACK') {
      throw new Error('Failed to send power command');
    }
  }
  async _onCapabilityVolumeUp(value, opts){
    let volume = this.getCapabilityValue('volume_set') * 100 + 1;
    if (volume > 100) volume = 100;
    this.log(`[Device] ${this.getName()}: onCapabilityVolumeUp =>`, volume);
    await this.setCapabilityValue('volume_set', volume / 100);
    let response = await this.api.setVolume(volume);
    if (response !== 'ACK') {
      throw new Error('Failed to send volume command');
    }
  }
  async _onCapabilityVolumeDown(value, opts){
    let volume = this.getCapabilityValue('volume_set') * 100 - 1;
    if (volume < 0) volume = 0;
    this.log(`[Device] ${this.getName()}: onCapabilityVolumeDown =>`, volume);
    await this.setCapabilityValue('volume_set', volume / 100);
    let response = await this.api.setVolume(volume);
    if (response !== 'ACK') {
      throw new Error('Failed to send volume command');
    }
  }
  async _onCapabilityVolumeSet(value, opts){
    this.log(`[Device] ${this.getName()}: onCapabilityVolumeSet =>`, value);
    let response = await this.api.setVolume(value * 100);
    if (response !== 'ACK') {
      throw new Error('Failed to send volume command');
    }
  }
  async _onCapabilityVolumeMute(value, opts){
    this.log(`[Device] ${this.getName()}: onCapabilityVolumeMute =>`, value);
    let response = await this.api.setMute(value);
    if (response !== 'ACK') {
      throw new Error('Failed to send mute command');
    }
  }
  async _onCapabilityVoiceEnhancer(value, opts){
    this.log(`[Device] ${this.getName()}: onCapabilityVoiceEnhancer =>`, value);
    let response = await this.api.setVoiceZoom3Value(value);
    if (response !== 'ACK') {
      throw new Error('Failed to send voice zoom 3 command');
    }
  }
  async _onCapabilityInputTheatre(value, opts){
    this.log(`[Device] ${this.getName()}: onCapabilityInputTheatre =>`, value);
    let response = await this.api.setSource(value);
    if (response !== 'ACK') {
      throw new Error('Failed to send input theatre command');
    }
  }
  async _onCapabilityRearLevel(value, opts){
    this.log(`[Device] ${this.getName()}: onCapabilityRearLevel =>`, value);
    let response = await this.api.setRearLevel(value);
    if (response !== 'ACK') {
      throw new Error('Failed to send rear level command');
    }
  }
  async _onCapabilityBassLevel(value, opts){
    this.log(`[Device] ${this.getName()}: onCapabilityBassLevel =>`, value);
    let response = await this.api.setBassLevel(value,  {hasSubwoofer: this.getSetting('has_subwoofer')});
    if (response !== 'ACK') {
      throw new Error('Failed to send bass level command');
    }
  }
  async _onCapabilitySoundField(value, opts){
    this.log(`[Device] ${this.getName()}: onCapabilitySoundField =>`, value);
    let response = await this.api.setSoundField(value);
    if (response !== 'ACK') {
      throw new Error('Failed to send sound field command');
    }
  }
  async _onCapabilityNightMode(value, opts){
    this.log(`[Device] ${this.getName()}: onCapabilityNightMode =>`, value);
    let response = await this.api.setNightMode(value);
    if (response !== 'ACK') {
      throw new Error('Failed to send night mode command');
    }
  }
  async _onCapabilityDrc(value, opts){
    this.log(`[Device] ${this.getName()}: onCapabilityDrc =>`, value);
    let response = await this.api.setDrc(value);
    if (response !== 'ACK') {
      throw new Error('Failed to send drc command');
    }
  }

  // Flow actions ===========================================================================================
  async flowActionInputTheatreSelect(args, state){
    this.log(`[Device] ${this.getName()}: flowActionInputTheatreSelect =>`, args.input_theatre);
    let response = await this.api.setSource(args.input_theatre);
    if (response !== 'ACK') {
      throw new Error('Failed to send input theatre command');
    }
    this.setCapabilityValue('input_theatre', args.input_theatre);
    return true;
  }

  async flowActionNightModeOn(args, state){
    this.log(`[Device] ${this.getName()}: flowActionNightModeOn =>`, args.night_mode);
    let response = await this.api.setNightMode(true);
    if (response !== 'ACK') {
      throw new Error('Failed to send night mode on command');
    }
    this.setCapabilityValue('night_mode', true);
    return true;
  }

  async flowActionNightModeOff(args, state){
    this.log(`[Device] ${this.getName()}: flowActionNightModeOff =>`, args.night_mode);
    let response = await this.api.setNightMode(false);
    if (response !== 'ACK') {
      throw new Error('Failed to send night mode off command');
    }
    this.setCapabilityValue('night_mode', false);
    return true;
  }

  async flowActionSoundFieldOn(args, state){
    this.log(`[Device] ${this.getName()}: flowActionSoundFieldOn =>`, args.sound_field);
    let response = await this.api.setSoundField(true);
    if (response !== 'ACK') {
      throw new Error('Failed to send sound field on command');
    }
    this.setCapabilityValue('sound_field', true);
    return true;
  }

  async flowActionSoundFieldOff(args, state){
    this.log(`[Device] ${this.getName()}: flowActionSoundFieldOff =>`, args.sound_field);
    let response = await this.api.setSoundField(false);
    if (response !== 'ACK') {
      throw new Error('Failed to send sound field off command');
    }
    this.setCapabilityValue('sound_field', false);
    return true;
  }

  async flowActionVoiceEnhancerLevel(args, state){
    this.log(`[Device] ${this.getName()}: flowActionVoiceEnhancerLevel =>`, args.level);
    let response = await this.api.setVoiceZoom3Value(args.level);
    if (response !== 'ACK') {
      throw new Error('Failed to send voice enhancer level command');
    }
    this.setCapabilityValue('voice_enhancer', args.level);
    return true;
  }

  async flowActionBassLevel(args, state){
    this.log(`[Device] ${this.getName()}: flowActionBassLevel =>`, args.level);
    let response = await this.api.setBassLevel(args.level, {hasSubwoofer: this.getSetting('has_subwoofer')});
    if (response !== 'ACK') {
      throw new Error('Failed to send bass level command');
    }
    this.setCapabilityValue('bass_level', args.level);
    return true;
  }

  async flowActionSoundRearLevel(args, state){
    this.log(`[Device] ${this.getName()}: flowActionSoundRearLevel =>`, args.level);
    let response = await this.api.setRearLevel(args.level);
    if (response !== 'ACK') {
      throw new Error('Failed to send rear level command');
    }
    this.setCapabilityValue('rear_level', args.level);
    return true;
  }

}

module.exports = SonyBraviaTheatreDevice;