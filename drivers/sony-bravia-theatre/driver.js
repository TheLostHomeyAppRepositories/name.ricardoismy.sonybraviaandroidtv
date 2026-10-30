const Homey = require('homey');

class SonyBraviaTheatreDriver extends Homey.Driver {
  async onInit(){  }

  async onPairListDevices() {
    const discoveryStrategy = this.getDiscoveryStrategy();
    const discoveryResults = discoveryStrategy.getDiscoveryResults();

    const devices = Object.values(discoveryResults).map(discoveryResult => {
      return {
        name: discoveryResult.name.replace(/-[a-f0-9]{40}$/i, ''),
        data: {
          id: discoveryResult.id,
        },
        store: {
          address: discoveryResult.txt?.ipaddr || discoveryResult.address,
          model: discoveryResult.txt?.imname,
          tcpPort: 33336,
          grpcPort: discoveryResult.port,
        }
      };
    });

    return devices;
  }
}

module.exports = SonyBraviaTheatreDriver;
