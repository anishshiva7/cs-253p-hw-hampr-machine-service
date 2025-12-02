import { DataCache } from "../database/cache";
import { MachineStateTable } from "../database/table";
import { IdentityProviderClient } from "../external/idp";
import { SmartMachineClient } from "../external/smart-machine";
import {
    GetMachineRequestModel,
    HttpResponseCode,
    MachineResponseModel,
    RequestMachineRequestModel,
    RequestModel,
    StartMachineRequestModel,
} from "./model";
import { MachineStateDocument, MachineStatus } from "../database/schema";

/**
 * Handles API requests for machine operations.
 * Routes requests and manages workflow of machine interactions.
 */
export class ApiHandler {
    private cache: DataCache<MachineStateDocument>;
    private db: MachineStateTable;
    private idp: IdentityProviderClient;
    private smart: SmartMachineClient;

    constructor() {
        this.cache = DataCache.getInstance<MachineStateDocument>();
        this.db = MachineStateTable.getInstance();
        this.idp = IdentityProviderClient.getInstance();
        this.smart = SmartMachineClient.getInstance();
    }

    /**
     * Validates an authentication token.
     * @param token The token to validate.
     * @throws An error if the token is invalid.
     */
    private checkToken(token: string): void {
        const valid = this.idp.validateToken(token);
        if (!valid) {
            throw new Error("Unauthorized");
        }
    }

    /**
     * Handles a request to find and reserve an available machine at a specific location.
     * It finds an available machine, updates its status to AWAITING_DROPOFF,
     * assigns the job ID, and caches the updated machine state.
     * NOTE: The current implementation assumes a machine will be held for a certain period,
     * but there is no mechanism to release the hold if the user doesn't proceed.
     * @param request The request model containing location and job IDs.
     * @returns A response model with the status code and the reserved machine's state.
     */
    private handleRequestMachine(
        request: RequestMachineRequestModel
    ): MachineResponseModel {
        const machines = this.db.listMachinesAtLocation(request.locationId);

        const available = machines.find(
            (m) => m.status === MachineStatus.AVAILABLE
        );
        if (!available) {
            return { statusCode: HttpResponseCode.NOT_FOUND };
        }

        available.status = MachineStatus.AWAITING_DROPOFF;
        available.currentJobId = request.jobId;

        this.db.updateMachineStatus(
            available.machineId,
            MachineStatus.AWAITING_DROPOFF
        );
        this.db.updateMachineJobId(available.machineId, request.jobId);
        this.cache.put(available.machineId, available);

        return { statusCode: HttpResponseCode.OK, machine: available };
    }

    /**
     * Retrieves the state of a specific machine.
     * It first checks the cache for the machine's data and, if not found, fetches it from the database.
     * @param request The request model containing the machine ID.
     * @returns A response model with the status code and the machine's state.
     */
    private handleGetMachine(
        request: GetMachineRequestModel
    ): MachineResponseModel {
        let machine = this.cache.get(request.machineId);

        if (!machine) {
            machine = this.db.getMachine(request.machineId);
            if (machine) {
                this.cache.put(machine.machineId, machine);
            }
        }

        if (!machine) {
            return { statusCode: HttpResponseCode.NOT_FOUND };
        }

        return { statusCode: HttpResponseCode.OK, machine };
    }

    /**
     * Starts the cycle of a machine that is awaiting drop-off.
     * It validates the machine's status, calls the external Smart Machine API to start the cycle,
     * and updates the machine's status to RUNNING.
     * @param request The request model containing the machine ID.
     * @returns A response model with the status code and the updated machine's state.
     */
    private handleStartMachine(
        request: StartMachineRequestModel
    ): MachineResponseModel {
        const machine = this.db.getMachine(request.machineId);
        if (!machine) {
            return { statusCode: HttpResponseCode.NOT_FOUND };
        }

        if (machine.status !== MachineStatus.AWAITING_DROPOFF) {
            return { statusCode: HttpResponseCode.BAD_REQUEST };
        }

        try {
            this.smart.startCycle(machine.machineId);
            this.db.updateMachineStatus(machine.machineId, MachineStatus.RUNNING);
            machine.status = MachineStatus.RUNNING;
            this.cache.put(machine.machineId, machine);

            return { statusCode: HttpResponseCode.OK, machine };
        } catch (err) {
            this.db.updateMachineStatus(machine.machineId, MachineStatus.ERROR);
            return { statusCode: HttpResponseCode.HARDWARE_ERROR };
        }
    }

    /**
     * The main entry point for handling all API requests.
     * It validates the token and routes the request to the appropriate private handler based on the method and path.
     * @param request The incoming request model.
     * @returns A response model from one of the specific handlers, or an error response.
     */
    public handle(request: RequestModel): MachineResponseModel {
        try {
            this.checkToken(request.token);

            if (request.method === "POST" && request.path === "/machine/request") {
                return this.handleRequestMachine(
                    request as RequestMachineRequestModel
                );
            }

            const getMatch = request.path.match(/^\/machine\/([a-zA-Z0-9-]+)$/);
            if (request.method === "GET" && getMatch) {
                const machineId = getMatch[1];
                const getRequest = { ...request, machineId } as GetMachineRequestModel;
                return this.handleGetMachine(getRequest);
            }

            const startMatch = request.path.match(/^\/machine\/([a-zA-Z0-9-]+)\/start$/);
            if (request.method === "POST" && startMatch) {
                const machineId = startMatch[1];
                const startRequest = { ...request, machineId } as StartMachineRequestModel;
                return this.handleStartMachine(startRequest);
            }

            return { statusCode: HttpResponseCode.BAD_REQUEST };
        } catch (err: any) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes("Unauthorized")) {
                return { statusCode: HttpResponseCode.UNAUTHORIZED };
            }
            return { statusCode: HttpResponseCode.INTERNAL_SERVER_ERROR };
        }
    }
}
