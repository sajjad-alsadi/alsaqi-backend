/**
 * Endpoint contract interfaces for the Correspondence module.
 * Defines the request/response shapes for each route.
 */
import type { Correspondence } from '../models';
import type {
  CreateIncomingCorrespondenceInput,
  UpdateIncomingCorrespondenceInput,
  CreateOutgoingCorrespondenceInput,
  UpdateOutgoingCorrespondenceInput,
} from '../../validators/correspondence';

export interface CorrespondenceEndpoints {
  'GET /correspondence': {
    query: { page?: number; pageSize?: number; type?: string; status?: string };
    response: Correspondence[];
  };
  'GET /correspondence/:id': {
    params: { id: string };
    response: Correspondence;
  };
  'POST /correspondence/incoming': {
    body: CreateIncomingCorrespondenceInput;
    response: Correspondence;
  };
  'PUT /correspondence/incoming/:id': {
    params: { id: string };
    body: UpdateIncomingCorrespondenceInput;
    response: Correspondence;
  };
  'POST /correspondence/outgoing': {
    body: CreateOutgoingCorrespondenceInput;
    response: Correspondence;
  };
  'PUT /correspondence/outgoing/:id': {
    params: { id: string };
    body: UpdateOutgoingCorrespondenceInput;
    response: Correspondence;
  };
  'DELETE /correspondence/:id': {
    params: { id: string };
    response: { deleted: boolean };
  };
}
