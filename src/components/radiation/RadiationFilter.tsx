/**
 * Filter component for radiation data queries
 */

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CalendarIcon } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import type { RadiationDataFilter, OrbitType, ParticleType } from '@/lib/types/radiation';

interface RadiationFilterProps {
  filter: RadiationDataFilter;
  onFilterChange: (filter: Partial<RadiationDataFilter>) => void;
  onApply?: () => void;
}

export function RadiationFilter({ filter, onFilterChange, onApply }: RadiationFilterProps) {
  const [startDate, setStartDate] = useState<Date | undefined>(
    filter.startTime ? new Date(filter.startTime) : undefined
  );
  const [endDate, setEndDate] = useState<Date | undefined>(
    filter.endTime ? new Date(filter.endTime) : undefined
  );

  const handleOrbitTypeChange = (orbitType: OrbitType, checked: boolean) => {
    const current = filter.orbitTypes || [];
    if (checked) {
      onFilterChange({ orbitTypes: [...current, orbitType] });
    } else {
      onFilterChange({ orbitTypes: current.filter((o) => o !== orbitType) });
    }
  };

  const handleParticleTypeChange = (particleType: ParticleType, checked: boolean) => {
    const current = filter.particleTypes || [];
    if (checked) {
      onFilterChange({ particleTypes: [...current, particleType] });
    } else {
      onFilterChange({ particleTypes: current.filter((p) => p !== particleType) });
    }
  };

  const handleStartDateChange = (date: Date | undefined) => {
    setStartDate(date);
    if (date) {
      onFilterChange({ startTime: date.toISOString() });
    } else {
      onFilterChange({ startTime: undefined });
    }
  };

  const handleEndDateChange = (date: Date | undefined) => {
    setEndDate(date);
    if (date) {
      onFilterChange({ endTime: date.toISOString() });
    } else {
      onFilterChange({ endTime: undefined });
    }
  };

  return (
    <Card role="region" aria-label="Radiation data filter controls">
      <CardHeader>
        <CardTitle>Filter Radiation Data</CardTitle>
        <CardDescription>Configure data source and time range filters</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Time Range */}
        <div className="space-y-2">
          <Label>Time Range</Label>
          <div className="grid grid-cols-2 gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    'w-full justify-start text-left font-normal',
                    !startDate && 'text-muted-foreground'
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {startDate ? format(startDate, 'PPP') : 'Start date'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0">
                <Calendar mode="single" selected={startDate} onSelect={handleStartDateChange} />
              </PopoverContent>
            </Popover>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    'w-full justify-start text-left font-normal',
                    !endDate && 'text-muted-foreground'
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {endDate ? format(endDate, 'PPP') : 'End date'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0">
                <Calendar mode="single" selected={endDate} onSelect={handleEndDateChange} />
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {/* Orbit Types */}
        <div className="space-y-2">
          <Label>Orbit Types</Label>
          <div className="flex flex-wrap gap-4">
            {(['LEO', 'MEO', 'GEO'] as OrbitType[]).map((orbitType) => (
              <div key={orbitType} className="flex items-center space-x-2">
                <Checkbox
                  id={`orbit-${orbitType}`}
                  checked={filter.orbitTypes?.includes(orbitType) || false}
                  onCheckedChange={(checked) =>
                    handleOrbitTypeChange(orbitType, checked as boolean)
                  }
                />
                <Label htmlFor={`orbit-${orbitType}`} className="cursor-pointer">
                  {orbitType}
                </Label>
              </div>
            ))}
          </div>
        </div>

        {/* Particle Types */}
        <div className="space-y-2">
          <Label>Particle Types</Label>
          <div className="flex flex-wrap gap-4">
            {(['proton', 'electron', 'alpha'] as ParticleType[]).map((particleType) => (
              <div key={particleType} className="flex items-center space-x-2">
                <Checkbox
                  id={`particle-${particleType}`}
                  checked={filter.particleTypes?.includes(particleType) || false}
                  onCheckedChange={(checked) =>
                    handleParticleTypeChange(particleType, checked as boolean)
                  }
                />
                <Label htmlFor={`particle-${particleType}`} className="cursor-pointer capitalize">
                  {particleType}
                </Label>
              </div>
            ))}
          </div>
        </div>

        {/* Energy Range */}
        <div className="space-y-2">
          <Label>Energy Range (MeV)</Label>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="energy-min" className="text-xs text-muted-foreground">
                Min
              </Label>
              <Input
                id="energy-min"
                type="number"
                placeholder="0.1"
                value={filter.energyRange?.min || ''}
                onChange={(e) =>
                  onFilterChange({
                    energyRange: {
                      min: parseFloat(e.target.value) || 0,
                      max: filter.energyRange?.max || 10,
                    },
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="energy-max" className="text-xs text-muted-foreground">
                Max
              </Label>
              <Input
                id="energy-max"
                type="number"
                placeholder="10"
                value={filter.energyRange?.max || ''}
                onChange={(e) =>
                  onFilterChange({
                    energyRange: {
                      min: filter.energyRange?.min || 0.1,
                      max: parseFloat(e.target.value) || 10,
                    },
                  })
                }
              />
            </div>
          </div>
        </div>

        {/* L-shell Range */}
        <div className="space-y-2">
          <Label>L-shell Range</Label>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="lshell-min" className="text-xs text-muted-foreground">
                Min
              </Label>
              <Input
                id="lshell-min"
                type="number"
                step="0.1"
                placeholder="1.0"
                value={filter.L_shellRange?.min || ''}
                onChange={(e) =>
                  onFilterChange({
                    L_shellRange: {
                      min: parseFloat(e.target.value) || 1,
                      max: filter.L_shellRange?.max || 10,
                    },
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lshell-max" className="text-xs text-muted-foreground">
                Max
              </Label>
              <Input
                id="lshell-max"
                type="number"
                step="0.1"
                placeholder="10.0"
                value={filter.L_shellRange?.max || ''}
                onChange={(e) =>
                  onFilterChange({
                    L_shellRange: {
                      min: filter.L_shellRange?.min || 1,
                      max: parseFloat(e.target.value) || 10,
                    },
                  })
                }
              />
            </div>
          </div>
        </div>

        {onApply && (
          <Button onClick={onApply} className="w-full">
            Apply Filters
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

