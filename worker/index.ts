/**
 * Worker entry point para poc-waiting-room-do
 *
 * Este Worker no maneja requests directos de usuarios.
 * Su unico proposito es exportar WaitingRoomDO para que
 * el Pages project pueda vincularlo via script_name.
 */
export { WaitingRoomDO } from '../functions/waiting-room-do';

export default {
  async fetch(): Promise<Response> {
    return new Response('WaitingRoom DO Worker — internal use only', {
      status: 200,
    });
  },
};
